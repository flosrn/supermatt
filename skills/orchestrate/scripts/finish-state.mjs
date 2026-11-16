#!/usr/bin/env node
// Versioned durable finish state for orchestrate.
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix } from "node:path";
import { parseArgs } from "node:util";

function fail(code, message) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const laneNumber = (value) => /^[1-9][0-9]*$/.test(value);
const statuses = ["working", "idle", "parked", "interrupted"];
const issueKey = (value) => typeof value === "string" && (laneNumber(value)
  || (!posix.isAbsolute(value) && posix.normalize(value) === value && value !== ".."
    && !value.startsWith("../") && !value.includes("\\") && value.endsWith(".md")));
const keyLocation = (key) => /^[A-Za-z0-9_]+$/.test(key) ? key : JSON.stringify(key);
const MAX_DEPTH = 2500;
const depthViolation = `root: nested deeper than ${MAX_DEPTH} levels; cannot be rewritten safely`;

function instant(value) {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, , offsetHour = "00", offsetMinute = "00"] = parts;
  const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return +month >= 1 && +month <= 12 && +day >= 1 && +day <= days[+month - 1]
    && +hour <= 23 && +minute <= 59 && +second <= 59 && +offsetHour <= 23 && +offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

function numberViolations(value, location = "") {
  const errors = [];
  const stack = [[value, location, 1]];
  while (stack.length) {
    const [current, path, depth] = stack.pop();
    if (typeof current === "number" && !Number.isFinite(current)) {
      errors.push(`${path || "root"}: number is out of range and cannot be preserved`);
    } else if (current !== null && typeof current === "object") {
      if (depth > MAX_DEPTH) return [depthViolation];
      const entries = Object.entries(current);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, child] = entries[index];
        stack.push([child, path ? `${path}.${keyLocation(key)}` : keyLocation(key), depth + 1]);
      }
    }
  }
  return errors;
}

function violations(state) {
  if (!object(state)) return ["root: must be an object"];
  if (!Object.hasOwn(state, "state_version")) return ["state_version: missing; legacy record, no shape guarantee"];
  const errors = numberViolations(state);
  if (errors[0] === depthViolation) return errors;
  try {
    JSON.stringify(state, null, 2);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    errors.push("root: too deeply nested to rewrite");
  }
  const add = (location, message) => errors.push(`${location}: ${message}`);
  if (state.state_version !== 1) add("state_version", "must be 1");
  if (typeof state.repository !== "string" || !isAbsolute(state.repository) || posix.normalize(state.repository) !== state.repository
    || (state.repository !== "/" && state.repository.endsWith("/"))) add("repository", "must be a canonical absolute path");
  if (!text(state.run_key)) add("run_key", "must be a non-empty string");
  if (!object(state.coordinator)) add("coordinator", "must be an object with a block");
  else if (!text(state.coordinator.block)) add("coordinator.block", "must be a non-empty string");
  const paneOwners = new Map();
  if (!object(state.lanes)) add("lanes", "must be an object keyed by lane number, not an array");
  else for (const [number, lane] of Object.entries(state.lanes)) {
    const path = `lanes.${keyLocation(number)}`;
    if (!laneNumber(number)) add(path, "lane key must be a decimal lane number without leading zeros");
    if (!object(lane)) {
      add(path, "must be an object");
      continue;
    }
    for (const key of ["issue", "branch"]) {
      if (key === "issue" && lane[key] !== null && !issueKey(lane[key])) add(`${path}.${key}`, "must be a decimal issue number or a repository-relative Markdown path");
      else if (key === "branch" && lane[key] !== null && !text(lane[key])) add(`${path}.${key}`, "must be a non-empty string or null");
      else if (lane.status === "idle" && lane[key] !== null) add(`${path}.${key}`, "must be null when idle");
      else if (key === "issue" && statuses.includes(lane.status) && lane.status !== "idle" && lane.issue === null) {
        add(`${path}.issue`, "must be non-null unless idle");
      }
    }
    if (!text(lane.pane)) add(`${path}.pane`, "must be a non-empty string");
    if (!Array.isArray(lane.panes) || lane.panes.length === 0 || !lane.panes.every(text)) {
      add(`${path}.panes`, "must be a non-empty array of non-empty strings");
    } else {
      const seen = new Set();
      for (const pane of lane.panes) {
        if (seen.has(pane)) add(`${path}.panes`, `duplicate pane ID ${JSON.stringify(pane)}`);
        if (!seen.has(pane) && paneOwners.has(pane) && paneOwners.get(pane) !== number) {
          add(`${path}.panes`, `pane ID ${JSON.stringify(pane)} already belongs to lane ${keyLocation(paneOwners.get(pane))}`);
        }
        if (!paneOwners.has(pane)) paneOwners.set(pane, number);
        seen.add(pane);
      }
      if (text(lane.pane) && lane.pane !== lane.panes[lane.panes.length - 1]) add(`${path}.pane`, "must equal the last element of panes");
    }
    if (!statuses.includes(lane.status)) add(`${path}.status`, "must be working, idle, parked or interrupted");
    if (lane.status === "parked") {
      if (!text(lane.park_reason)) add(`${path}.park_reason`, "must be a non-empty string when parked");
    } else if (lane.park_reason != null) add(`${path}.park_reason`, "must be absent or null unless parked");
    if (typeof lane.park_reason === "string" && /[\r\n]/.test(lane.park_reason)) add(`${path}.park_reason`, "must not contain a line break");
  }
  if (state.wait != null) {
    if (!object(state.wait)) add("wait", "must be an object or null");
    else {
      if (!text(state.wait.resource)) add("wait.resource", "must be a non-empty string");
      if (typeof state.wait.resource === "string" && /[\r\n]/.test(state.wait.resource)) add("wait.resource", "must not contain a line break");
      if (!instant(state.wait.since)) add("wait.since", "must be a valid date-time with seconds and a Z or +-HH:MM offset");
    }
  }
  return errors;
}

function check(state) {
  const errors = violations(state);
  if (errors.length) fail(1, errors.join("\n"));
}

function makePrivateDirectory(directory) {
  const missing = [];
  for (let level = directory; ; level = dirname(level)) {
    try {
      if (!statSync(level).isDirectory()) fail(2, `${level}: not a directory`);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(level);
    }
  }
  while (missing.length) {
    const level = missing.pop();
    try {
      mkdirSync(level, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!statSync(level).isDirectory()) fail(2, `${level}: not a directory`);
      continue;
    }
    chmodSync(level, 0o700);
  }
}

function save(file, state, exclusive = false) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    if (exclusive) {
      try { linkSync(temp, file); }
      catch (error) {
        if (error.code === "EEXIST") fail(1, "file: already exists");
        throw error;
      }
    } else renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function laneWrite(state, number, values) {
  if (!object(state.lanes)) return;
  const previous = state.lanes[number];
  if (previous !== undefined && !object(previous)) return;
  const lane = previous ?? { issue: null, branch: null, pane: undefined, panes: [], status: undefined };
  if (values.issue !== undefined) {
    if (values.issue !== lane.issue && values.branch === undefined) lane.branch = null;
    lane.issue = values.issue;
  }
  if (values.branch !== undefined) lane.branch = values.branch;
  if (values.pane !== undefined && values.pane !== lane.pane) {
    if (Array.isArray(lane.panes)) lane.panes.push(values.pane);
    lane.pane = values.pane;
  }
  if (values.status !== undefined) {
    lane.status = values.status;
    if (values.status === "idle") {
      if (values.issue === undefined) lane.issue = null;
      if (values.branch === undefined) lane.branch = null;
    }
    if (values.status !== "parked") delete lane.park_reason;
  }
  if (values["park-reason"] !== undefined) lane.park_reason = values["park-reason"];
  state.lanes[number] = lane;
}

function main(argv) {
  const [command, ...args] = argv;
  const commands = { create: ["repository", "run-key", "coordinator"], coordinator: [], lane: ["issue", "branch", "pane", "status", "park-reason"], "wait-set": [], "wait-clear": [], check: [] };
  if (!Object.hasOwn(commands, command)) fail(2, "usage: expected create, coordinator, lane, wait-set, wait-clear or check");
  const options = Object.fromEntries(commands[command].map((key) => [key, { type: "string" }]));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });
  const count = command === "lane" || command === "wait-set" || command === "coordinator" ? 2 : 1;
  if (positionals.length !== count || !positionals[0]) {
    fail(2, command === "coordinator" ? "usage: coordinator FILE ID" : `usage: ${command} expects ${count} positional arguments`);
  }
  const [file, argument] = positionals;
  if (command === "lane" && !laneNumber(argument)) fail(2, "usage: lane must be a decimal lane number without leading zeros");
  if (command === "create") {
    if (values.repository === undefined || values["run-key"] === undefined || values.coordinator === undefined) {
      fail(2, "usage: create FILE --repository PATH --run-key KEY --coordinator ID");
    }
    const state = { state_version: 1, repository: values.repository, run_key: values["run-key"], coordinator: { block: values.coordinator }, lanes: {} };
    check(state);
    makePrivateDirectory(dirname(file));
    save(file, state, true);
  } else if (command === "check") {
    check(JSON.parse(readFileSync(file, "utf8")));
  } else {
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (object(state) && !Object.hasOwn(state, "state_version")) fail(1, "state_version: legacy record is not rewritten");
    if (!object(state)) check(state);
    const numberErrors = numberViolations(state);
    if (numberErrors.length) fail(1, numberErrors.join("\n"));
    if (command === "lane") laneWrite(state, argument, values);
    if (command === "coordinator") {
      if (!object(state.coordinator)) state.coordinator = {};
      state.coordinator.block = argument;
    }
    if (command === "wait-set" && (!object(state.wait) || state.wait.resource !== argument)) {
      state.wait = { ...(object(state.wait) ? state.wait : {}), resource: argument, since: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
    }
    if (command === "wait-clear") state.wait = null;
    check(state);
    save(file, state);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.exitCode === 1 ? error.message : error.message.replace(/[\r\n]+/g, " "));
  process.exitCode = error.exitCode ?? 2;
}
