#!/usr/bin/env node
// A host-side poller, not a model loop. Registrations and delivery receipts have separate writers.
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const SENDER = "supermatt-merge-train";
const SHA = /^[0-9a-f]{40}$/;
const BLOCK = /^[0-9]+$/;
const ALIAS = /^[a-z][a-z0-9_-]{0,31}$/;
const herdr = fileURLToPath(new URL("../../orchestrate/scripts/tern-herdr.mjs", import.meta.url));
const notifier = fileURLToPath(new URL("../../orchestrate/scripts/tern-notify.mjs", import.meta.url));
const usage = "merge-train-watch.mjs register --repo OWNER/REPO --train-login LOGIN --state DIR --pr N [--owner BLOCK] [--coordinator BLOCK] [--owner-agent NAME] [--coordinator-agent NAME]\nmerge-train-watch.mjs watch --repo OWNER/REPO --train-login LOGIN --state DIR [--coordinator BLOCK] [--coordinator-agent NAME] [--interval 60] [--once] [--dry-run] [--until-event]";

function run(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

function json(text, source) {
  try { return JSON.parse(text); } catch { throw new Error(`invalid JSON from ${source}`); }
}

function readJson(path, absent) {
  try { return json(readFileSync(path, "utf8"), path); } catch (error) {
    if (error.code === "ENOENT") return absent;
    throw error;
  }
}

function atomicJson(path, value, exclusive = false) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    if (exclusive) linkSync(tmp, path);
    else renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function dependencies(overrides) {
  const deps = { env: process.env, run, alive, sleep, out: (value) => process.stdout.write(`${JSON.stringify(value)}\n`), ...overrides };
  return { ...deps, exec: (command, args) => deps.run(command, args, deps.env), query: (command, args) => json(deps.run(command, args, deps.env), command) };
}

function parse(argv, env) {
  const [command, ...args] = argv;
  if (!["register", "watch"].includes(command)) throw new Error(usage);
  const values = command === "register" ? ["repo", "train-login", "state", "pr", "owner", "coordinator", "owner-agent", "coordinator-agent"] : ["repo", "train-login", "state", "coordinator", "coordinator-agent", "interval"];
  const flags = command === "watch" ? ["once", "dry-run", "until-event"] : [];
  const options = { command };
  for (let index = 0; index < args.length; index++) {
    const key = args[index].startsWith("--") ? args[index].slice(2) : "";
    if (Object.hasOwn(options, key)) throw new Error(`duplicate option --${key}`);
    if (flags.includes(key)) options[key] = true;
    else if (values.includes(key) && args[index + 1] && !args[index + 1].startsWith("--")) options[key] = args[++index];
    else throw new Error(`invalid option ${args[index]}\n${usage}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo || "") || !options.state) throw new Error(usage);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/.test(options["train-login"] || "")) throw new Error("--train-login must explicitly name the trusted merge-train actor");
  options.repo = options.repo.toLowerCase();
  options.state = resolve(options.state);
  if (command === "register") {
    if (!/^[1-9][0-9]*$/.test(options.pr || "")) throw new Error("--pr must be a positive integer");
    options.owner ??= env.TERN_PANE;
  }
  for (const role of ["owner", "coordinator"]) {
    if (options[role] !== undefined && !BLOCK.test(options[role])) throw new Error(`--${role} must be a local Tern block`);
    if (options[`${role}-agent`] && (!ALIAS.test(options[`${role}-agent`]) || !options[role])) throw new Error(`--${role}-agent requires --${role} and a valid registered agent name`);
  }
  options.interval = Number(options.interval ?? 60);
  if (!Number.isInteger(options.interval) || options.interval < 60) throw new Error("--interval must be an integer of at least 60 seconds");
  options.once = options.once || options["dry-run"];
  return options;
}

function stateRepo(options, mutate) {
  const path = join(options.state, "repo.json");
  let record = readJson(path, undefined);
  if (record === undefined && mutate) {
    mkdirSync(options.state, { recursive: true, mode: 0o700 });
    try { atomicJson(path, { version: 1, repo: options.repo, trainLogin: options["train-login"] }, true); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    record = readJson(path);
  }
  if (record !== undefined && (record?.version !== 1 || record.repo !== options.repo || record.trainLogin !== options["train-login"])) throw new Error("--state belongs to a different repository, train login or version");
}

function lock(options, deps) {
  const dir = join(options.state, "watch.lock");
  const name = `${process.pid}-${randomUUID()}.json`;
  for (;;) {
    const staging = join(options.state, `.watch-${name}`);
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, name), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
    try {
      renameSync(staging, dir);
      return () => {
        unlinkSync(join(dir, name));
        try { rmdirSync(dir); } catch (error) { if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      unlinkSync(join(staging, name));
      rmdirSync(staging);
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    }
    const entries = readdirSync(dir);
    // An incomplete acquisition is ambiguous. Fail closed rather than steal from its creator.
    if (entries.length !== 1 || !/^[1-9][0-9]*-[0-9a-f-]+\.json$/.test(entries[0])) throw new Error("watch lock is incomplete; inspect its owner before removing it");
    const ownerPath = join(dir, entries[0]);
    const owner = readJson(ownerPath);
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) throw new Error("invalid watch lock owner");
    if (deps.alive(owner.pid)) throw new Error(`watch already running with pid ${owner.pid}`);
    // Only the process that deletes this unique dead owner's file may remove its directory.
    // A competing recovery cannot delete a later owner's differently named file.
    try { unlinkSync(ownerPath); } catch (error) {
      if (error.code === "ENOENT") throw new Error("another watcher is recovering the lock");
      throw error;
    }
    try { rmdirSync(dir); } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    }
  }
}

function sessions(deps) {
  const result = deps.query("tern-sessions", ["list", "--json"]);
  if (result.version !== 1 || !Array.isArray(result.sessions)) throw new Error("invalid tern-sessions list response");
  return result.sessions;
}

function identity(session, block) {
  return session && !session.host && String(session.block) === block && Number.isSafeInteger(session.pid) && session.pid > 0 && typeof session.sessionFile === "string" && session.sessionFile.length > 0;
}

function pin(block, alias, listed) {
  if (!block) return undefined;
  const session = listed.find((item) => identity(item, block));
  return session ? { block, pid: session.pid, sessionFile: session.sessionFile, ...(alias ? { agent: alias } : {}) } : undefined;
}

function matching(pin, listed) {
  return listed.find((item) => identity(item, pin.block) && item.pid === pin.pid && item.sessionFile === pin.sessionFile);
}

function ready(session) {
  return session && ["idle", "working"].includes(session.state) && !session.pendingAsk;
}

function agents(deps) {
  const result = deps.query(process.execPath, [herdr, "agent", "list"]);
  if (!Array.isArray(result.result?.agents)) throw new Error("invalid tern-herdr agent list response");
  return result.result.agents;
}

function matchingAgent(pin, listed) {
  return listed.find((agent) => agent.name === pin.agent && String(agent.pane_id) === pin.block && agent.pid === pin.pid && agent.agent_session?.value === pin.sessionFile && ["idle", "working"].includes(agent.agent_status));
}

function registrationPath(options, pr) { return join(options.state, "registrations", `${pr}.json`); }

function registration(options, pr) {
  const record = readJson(registrationPath(options, pr), undefined);
  if (record === undefined) return undefined;
  if (record?.version !== 1 || record.repo !== options.repo || record.pr !== pr) throw new Error(`invalid registration for PR ${pr}`);
  for (const role of ["owner", "coordinator"]) {
    const target = record[role];
    if (target && (!BLOCK.test(target.block) || !Number.isSafeInteger(target.pid) || target.pid < 1 || typeof target.sessionFile !== "string" || !target.sessionFile || (target.agent && !ALIAS.test(target.agent)))) throw new Error(`invalid ${role} registration for PR ${pr}`);
  }
  return record;
}

function register(options, deps) {
  const listed = sessions(deps);
  const record = { version: 1, repo: options.repo, pr: Number(options.pr), registeredAt: new Date().toISOString(), ...(BLOCK.test(deps.env.TERN_PANE || "") ? { origin: deps.env.TERN_PANE } : {}) };
  let named;
  for (const role of ["owner", "coordinator"]) {
    if (!options[role]) continue;
    const target = pin(options[role], options[`${role}-agent`], listed);
    if (!target) throw new Error(`cannot register ${role}: no live local session identity in block ${options[role]}`);
    if (target.agent && !matchingAgent(target, named ??= agents(deps))) throw new Error(`cannot register ${role}: agent alias does not match the live block, pid and session file`);
    record[role] = target;
  }
  stateRepo(options, true);
  mkdirSync(join(options.state, "registrations"), { recursive: true, mode: 0o700 });
  atomicJson(registrationPath(options, record.pr), record);
  return { event: "registered", ...record };
}

function pages(deps, endpoint) {
  const result = deps.query("gh", ["api", endpoint, "--paginate", "--slurp"]);
  if (!Array.isArray(result) || !result.every(Array.isArray)) throw new Error(`invalid paginated response from ${endpoint}`);
  return result.flat();
}

function pull(deps, repo, number) {
  const pr = deps.query("gh", ["api", `repos/${repo}/pulls/${number}`]);
  if (pr.number !== number || !["open", "closed"].includes(pr.state) || !SHA.test(pr.head?.sha || "") || !Array.isArray(pr.labels) || !pr.labels.every((label) => typeof label.name === "string")) throw new Error(`invalid pull request response for PR ${number}`);
  return pr;
}

function eligible(pr) { return pr.state === "open" && pr.labels.some((label) => label.name === "merge"); }

function conflict(comments, head, trainLogin) {
  let held;
  let found = false;
  const ordered = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  for (const comment of ordered) {
    if (comment.user?.login !== trainLogin) continue;
    for (const marker of comment.body.matchAll(/<!-- merge-train:(conflict|held|approved) ([0-9a-f]{40}) -->/g)) {
      if (marker[1] === "held") held = marker[2];
      if (marker[1] === "approved" && held === marker[2]) held = undefined;
      if (marker[1] === "conflict" && marker[2] === head) found = true;
    }
  }
  return found && !held;
}

function scan(options, deps) {
  const issues = pages(deps, `repos/${options.repo}/issues?state=open&labels=merge&per_page=100`);
  const events = [];
  const seen = new Set();
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error("invalid issue listing");
    if (!issue.pull_request || seen.has(issue.number)) continue;
    seen.add(issue.number);
    const pr = pull(deps, options.repo, issue.number);
    if (!eligible(pr)) continue;
    const comments = pages(deps, `repos/${options.repo}/issues/${issue.number}/comments?per_page=100`);
    if (!comments.every((item) => Number.isSafeInteger(item.id) && typeof item.created_at === "string" && typeof item.body === "string" && typeof item.user?.login === "string")) throw new Error(`invalid comments for PR ${issue.number}`);
    if (!conflict(comments, pr.head.sha, options["train-login"])) continue;
    const current = pull(deps, options.repo, issue.number);
    if (eligible(current) && current.head.sha === pr.head.sha) events.push({ pr: issue.number, head: pr.head.sha, url: `https://github.com/${options.repo}/pull/${issue.number}` });
  }
  return { events, open: seen.size };
}

function trusted(deps) {
  const path = deps.env.TERN_SESSIONS_CONFIG?.trim() || join(deps.env.HOME || homedir(), ".config", "tern-sessions", "config.json");
  const config = readJson(path, {});
  return Array.isArray(config.trustedSenders) && config.trustedSenders.includes(SENDER);
}

function message(event, record) {
  return `Merge-train conflict on ${event.url} at head ${event.head}. Follow this repository's merge documentation: re-sync the current PR with main under the repository's published-branch rules, preserving the merge label and holds; rebase only if authorized and use the required lease. Resume the original shipping record and its owning worktree; do not take over an unrelated checkout.${record?.owner ? ` Registered shipping owner: block ${record.owner.block}.` : " No shipping owner is registered; coordinate ownership before changing a worktree."}`;
}

function routes(options, record, globalCoordinator, listed, named, authorized, deps) {
  const result = [];
  const targets = [["owner", record?.owner], ["coordinator", record?.coordinator || globalCoordinator]];
  const used = new Set();
  for (const [role, target] of targets) {
    if (!target || used.has(target.block)) continue;
    used.add(target.block);
    const session = matching(target, listed);
    if (!ready(session)) continue;
    if (authorized && session.canReceive === true) result.push({ kind: "message", role, block: target.block, target });
    if (target.agent && matchingAgent(target, named)) result.push({ kind: "prompt", role, block: target.block, agent: target.agent, target });
  }
  const panes = [record?.coordinator?.block, options.coordinator, record?.origin, deps.env.TERN_PANE].filter((block) => BLOCK.test(block || ""));
  for (const block of new Set(panes)) result.push({ kind: "notification", block });
  return result;
}

function deliver(route, text, deps) {
  if (route.kind === "notification") {
    deps.exec(process.execPath, [notifier, "--pane", route.block, "Merge train needs a rebase", text]);
    return "notification";
  }
  // Refresh identity at the effect, not just when planning. A reused pane is never an owner.
  const session = matching(route.target, sessions(deps));
  if (!ready(session)) throw new Error("registered session moved, stopped or is waiting for its user");
  if (route.kind === "message") {
    if (session.canReceive !== true || !trusted(deps)) throw new Error("session inbox or trusted sender unavailable");
    const sent = deps.query("tern-sessions", ["send", route.block, text, "--from", SENDER, "--json"]);
    if (sent.version !== 1 || String(sent.block) !== route.block || sent.from !== SENDER || sent.left !== true) throw new Error("tern-sessions did not accept the message");
    return "queued";
  }
  if (!matchingAgent(route.target, agents(deps))) throw new Error("registered agent alias moved, stopped or is waiting for its user");
  const sent = deps.query(process.execPath, [herdr, "agent", "prompt", route.agent, text]);
  if (!matchingAgent(route.target, [sent.result?.agent].filter(Boolean))) throw new Error("tern-herdr did not confirm the registered agent");
  return "accepted";
}

function tick(options, deps, globalCoordinator) {
  const ledgerPath = join(options.state, "delivered.json");
  const ledger = readJson(ledgerPath, { version: 1, repo: options.repo, events: {} });
  if (ledger.version !== 1 || ledger.repo !== options.repo || !ledger.events || typeof ledger.events !== "object" || Array.isArray(ledger.events)) throw new Error("invalid delivery ledger");
  const snapshot = scan(options, deps);
  const pending = snapshot.events.filter((event) => !Object.hasOwn(ledger.events, `${event.pr}:${event.head}`));
  const results = [];
  if (!pending.length) return { event: "tick", open: snapshot.open, results };
  let listed = [];
  const errors = [];
  try { listed = sessions(deps); } catch (error) { errors.push(error.message); }
  let authorized = false;
  try { authorized = trusted(deps); } catch (error) { errors.push(error.message); }
  let named = [];
  const records = pending.map((event) => registration(options, event.pr));
  if ([globalCoordinator, ...records.flatMap((record) => [record?.owner, record?.coordinator])].some((target) => target?.agent)) {
    try { named = agents(deps); } catch (error) { errors.push(error.message); }
  }
  events: for (const [index, event] of pending.entries()) {
    const current = pull(deps, options.repo, event.pr);
    if (!eligible(current) || current.head.sha !== event.head) continue;
    const record = records[index];
    const candidates = routes(options, record, globalCoordinator, listed, named, authorized, deps);
    const plan = candidates.map(({ target, ...route }) => route);
    if (options["dry-run"]) { results.push({ ...event, outcome: "planned", routes: plan, errors }); continue; }
    const failures = [...errors];
    let receipt;
    for (const route of candidates) {
      const current = pull(deps, options.repo, event.pr);
      if (!eligible(current) || current.head.sha !== event.head) continue events;
      try {
        const outcome = deliver(route, message(event, record), deps);
        receipt = { kind: route.kind, ...(route.role ? { role: route.role } : {}), block: route.block, outcome, at: new Date().toISOString() };
        break;
      } catch (error) { failures.push(`${route.kind} ${route.block}: ${error.message}`); }
    }
    if (receipt) {
      ledger.events[`${event.pr}:${event.head}`] = receipt;
      atomicJson(ledgerPath, ledger);
      results.push({ ...event, ...receipt, errors: failures });
    } else results.push({ ...event, outcome: "pending", errors: failures.length ? failures : ["no reachable session or notification pane"] });
  }
  return { event: "tick", open: snapshot.open, results };
}

// Tests inject only host transports/output. Routing, CLI parsing, files and locking stay real.
export async function runCli(argv, overrides = {}) {
  const deps = dependencies(overrides);
  const options = parse(argv, deps.env);
  if (options.command === "register") { deps.out(register(options, deps)); return; }
  stateRepo(options, !options["dry-run"]);
  const release = options["dry-run"] ? () => {} : lock(options, deps);
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (!options.once) { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  try {
    let coordinator;
    if (options.coordinator) {
      try { coordinator = pin(options.coordinator, options["coordinator-agent"], sessions(deps)); }
      catch (error) { deps.out({ event: "warning", error: error.message }); }
    }
    if (!options.once) deps.out({ event: "ready", repo: options.repo, state: options.state, pid: process.pid, interval: options.interval, ...(options.coordinator ? { coordinator: options.coordinator } : {}) });
    do {
      try {
        const result = tick(options, deps, coordinator);
        if (!options["until-event"] || result.results.length) deps.out(result);
        if ((options.once || options["until-event"]) && result.results.some((event) => event.outcome === "pending")) throw new Error("conflict delivery remains pending");
        if (options["until-event"] && result.results.length) break;
      } catch (error) {
        if (options.once || options["until-event"]) throw error;
        deps.out({ event: "error", error: error.message });
      }
      if (options.once || controller.signal.aborted) break;
      try { await deps.sleep(options.interval * 1000, undefined, { signal: controller.signal }); }
      catch (error) { if (error.name !== "AbortError") throw error; }
    } while (!controller.signal.aborted);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch((error) => { console.error(JSON.stringify({ event: "error", error: error.message })); process.exitCode = 1; });
}
