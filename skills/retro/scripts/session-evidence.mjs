#!/usr/bin/env node

import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";

const HOSTS = new Set(["claude", "codex", "cursor", "omp"]);

function fail(message) {
  throw new Error(message);
}

function inside(root, path) {
  const rel = relative(realpathSync(root), realpathSync(path));
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function text(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    if (["text", "input_text", "output_text"].includes(item.type) && typeof item.text === "string") return [item.text];
    if (typeof item.content === "string") return [item.content];
    return [];
  }).filter(Boolean).join("\n");
}

function jsonl(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).flatMap((source, index) => {
    if (!source.trim()) return [];
    try {
      return [{ line: index + 1, value: JSON.parse(source) }];
    } catch {
      fail(`malformed JSONL at ${path}:${index + 1}`);
    }
  });
}

function* jsonlPrefix(path) {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let line = 0;
  try {
    let size;
    do {
      size = readSync(descriptor, buffer, 0, buffer.length, null);
      pending += size ? decoder.write(buffer.subarray(0, size)) : decoder.end();
      let end;
      while ((end = pending.indexOf("\n")) !== -1 || (!size && pending.length)) {
        const source = end === -1 ? pending : pending.slice(0, end);
        pending = end === -1 ? "" : pending.slice(end + 1);
        line++;
        if (!source.trim()) continue;
        try {
          yield JSON.parse(source);
        } catch {
          fail(`malformed JSONL at ${path}:${line}`);
        }
      }
    } while (size);
  } finally {
    closeSync(descriptor);
  }
}

function files(path, accept, depth = 3) {
  if (!existsSync(path) || depth < 0) return [];
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return files(child, accept, depth - 1);
    return accept(child) ? [child] : [];
  });
}

function cursorRecords(path, main = false) {
  const entries = jsonl(path);
  const records = [];
  for (const { line, value } of entries) {
    const role = value?.role;
    const content = value?.message?.content;
    if (!Array.isArray(content) || !["user", "assistant", "tool"].includes(role)) continue;
    const spoken = text(content.filter((item) => item?.type !== "tool_result"));
    if (spoken && role !== "tool") records.push({ line, kind: role, text: spoken });
    for (const item of content) {
      if (item?.type !== "tool_result" || !(item.is_error || item.isError)) continue;
      const error = text(item.content);
      if (error) records.push({ line, kind: "tool-error", text: error });
    }
  }
  if (!records.length || (main && !records.some(({ kind }) => kind === "user"))) {
    fail(`unsupported Cursor transcript layout at ${path}`);
  }
  return records;
}

function cursorSession(path) {
  const directory = dirname(path);
  const sessions = [{ path, records: cursorRecords(path, true) }];
  for (const child of files(join(directory, "subagents"), (file) => extname(file) === ".jsonl")) {
    if (!inside(directory, child)) fail(`path is outside the verified Cursor session root: ${child}`);
    const canonical = realpathSync(child);
    sessions.push({ path: canonical, records: cursorRecords(canonical) });
  }
  for (const summary of files(join(directory, "compaction"), () => true)) {
    if (!inside(directory, summary)) fail(`path is outside the verified Cursor session root: ${summary}`);
    const value = readFileSync(summary, "utf8").trim();
    if (value) sessions.push({ path: realpathSync(summary), records: [{ line: 1, kind: "summary", text: value }] });
  }
  return sessions;
}

function activeEntries(entries) {
  const indexed = new Map(entries.filter(({ value }) => value?.id).map((entry) => [entry.value.id, entry]));
  const last = entries.findLast(({ value }) => value?.id && value.type !== "session");
  let leafId = last?.value.type === "model_usage" && last.value.activeLeafId !== undefined
    ? last.value.activeLeafId
    : last?.value.id;
  if (typeof leafId === "string" && !indexed.has(leafId)) {
    leafId = entries.findLast(({ value }) => value?.id && value.type !== "session"
      && (value.type !== "model_usage" || value.activeLeafId === undefined || value.activeLeafId === value.id))?.value.id;
  }
  let current = typeof leafId === "string" ? indexed.get(leafId) : undefined;
  const active = new Set();
  while (current && !active.has(current.value.id)) {
    active.add(current.value.id);
    current = current.value.parentId == null ? undefined : indexed.get(current.value.parentId);
  }
  return entries.filter(({ value }) => !value?.id || active.has(value.id));
}

function ompRecords(path, main = false, cwd, entries = jsonl(path)) {
  const header = entries.find(({ value }) => value?.type === "session")?.value;
  if (!header || resolve(header.cwd) !== cwd) fail(`unsupported or mismatched OMP transcript at ${path}`);
  const records = [];
  for (const { line, value } of activeEntries(entries)) {
    if (["compaction", "branch_summary", "summary"].includes(value?.type)) {
      if (typeof value.summary === "string" && value.summary) records.push({ line, kind: "summary", text: value.summary });
      continue;
    }
    if (value?.type === "custom_message" && value.customType === "skill-prompt") {
      const spoken = text(value.content);
      if (spoken) records.push({ line, kind: "user", text: spoken });
      continue;
    }
    if (value?.type !== "message") continue;
    const role = value.message?.role;
    const spoken = text(value.message?.content);
    if (!spoken) continue;
    if (["user", "developer"].includes(role)) records.push({ line, kind: "user", text: spoken });
    else if (role === "assistant") records.push({ line, kind: "assistant", text: spoken });
    else if (role === "toolResult" && (value.message?.isError || value.message?.is_error || value.message?.details?.isError)) records.push({ line, kind: "tool-error", text: spoken });
  }
  if (!records.length || (main && !records.some(({ kind }) => kind === "user"))) fail(`unsupported OMP transcript schema at ${path}`);
  return records;
}

function ompChildIds(entries) {
  const calls = new Set();
  for (const { value } of entries) {
    if (value?.type !== "message" || value.message?.role !== "assistant" || !Array.isArray(value.message.content)) continue;
    for (const call of value.message.content) {
      if (call?.type === "toolCall" && call.name === "task" && typeof call.id === "string") calls.add(call.id);
    }
  }
  const ids = new Set();
  for (const { value } of entries) {
    const message = value?.message;
    if (value?.type !== "message" || message?.role !== "toolResult" || !calls.has(message.toolCallId)) continue;
    // OMP task results and async progress persist allocated IDs, not requested names.
    for (const list of [message.details?.results, message.details?.progress]) {
      if (!Array.isArray(list)) continue;
      for (const result of list) {
        if (typeof result?.id === "string") ids.add(result.id);
      }
    }
  }
  return ids;
}

function ompSession(path, cwd, gaps) {
  const root = path.slice(0, -extname(path).length);
  const candidates = files(root, (file) => extname(file) === ".jsonl" && !basename(file).startsWith("."), Infinity);
  const entries = new Map([[path, jsonl(path)]]);
  const names = new Map();
  const readErrors = new Map();
  for (const child of candidates) {
    let canonical;
    try {
      canonical = realpathSync(child);
    } catch (error) {
      readErrors.set(child, error);
      names.set(child, child);
      continue;
    }
    if (!inside(root, canonical)) fail(`path is outside the verified OMP child root: ${child}`);
    names.set(child, canonical);
  }
  const sessions = new Map();
  const visited = new Map();
  const visit = (parent, included) => {
    const states = visited.get(parent) ?? new Set();
    if (states.has(included)) return;
    states.add(included);
    visited.set(parent, states);
    if (!entries.has(parent)) {
      try {
        if (readErrors.has(parent)) throw readErrors.get(parent);
        entries.set(parent, jsonl(parent));
      } catch (error) {
        if (included) throw error;
        gaps.push(`OMP child ${parent}: inactive branch transcript excluded; ${error.message}`);
        return;
      }
    }
    const journal = entries.get(parent);
    if (included) sessions.set(parent, { path: parent, records: ompRecords(parent, parent === path, cwd, journal) });
    const active = included ? ompChildIds(activeEntries(journal)) : new Set();
    for (const id of ompChildIds(journal)) {
      if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(id)) {
        if (active.has(id)) gaps.push(`OMP child ${id}: invalid allocated task ID; association was not established`);
        continue;
      }
      const localRoot = parent.slice(0, -extname(parent).length);
      const matches = [...new Set([names.get(join(root, `${id}.jsonl`)), names.get(join(localRoot, `${id}.jsonl`))].filter(Boolean))];
      if (matches.length !== 1) {
        if (active.has(id)) gaps.push(`OMP child ${id} from ${parent}: unique transcript association was not established`);
        continue;
      }
      visit(matches[0], active.has(id));
    }
  };
  visit(path, true);
  for (const child of new Set(names.values())) {
    if (!visited.has(child)) {
      const error = readErrors.get(child);
      gaps.push(`OMP child ${child}: parent task branch association was not established; transcript excluded${error ? `; ${error.message}` : ""}`);
    }
  }
  return [...sessions.values()];
}

function failedOutput(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = failedOutput(item);
      if (failure) return failure;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  if ((Number.isInteger(value.exit_code) && value.exit_code !== 0) || ["error", "failed", "rejected"].includes(value.status)) {
    return typeof value.output === "string" && value.output ? value.output : JSON.stringify(value);
  }
  for (const item of Object.values(value)) {
    const failure = failedOutput(item);
    if (failure) return failure;
  }
  return "";
}

function codexToolError(item) {
  if (item?.type === "item_completed" && item.item?.type === "CommandExecution"
    && (item.item.exit_code !== 0 || ["error", "failed", "rejected"].includes(item.item.status))) {
    return item.item.aggregated_output || JSON.stringify(item.item);
  }
  if (!["custom_tool_call_output", "function_call_output"].includes(item?.type)) return "";
  const output = text(item.output);
  if (item.is_error || item.isError || ["error", "failed", "rejected"].includes(item.status)) return output;
  const blocks = Array.isArray(item.output) ? item.output : [{ text: output }];
  for (const block of blocks) {
    if (typeof block?.text !== "string") continue;
    try {
      const failure = failedOutput(JSON.parse(block.text));
      if (failure) return failure;
    } catch {
      // Non-JSON tool output has no machine-readable failure status.
    }
  }
  return "";
}

function genericRecords(path, host, main, cwd) {
  const records = [];
  const entries = jsonl(path);
  if (host === "claude" && !entries.some(({ value }) =>
    ["user", "assistant"].includes(value?.type) && ["user", "assistant"].includes(value.message?.role))) {
    fail(`unsupported claude transcript schema at ${path}`);
  }
  const workspaces = host === "claude"
    ? entries.flatMap(({ value }) => typeof value?.cwd === "string" ? [value.cwd] : [])
    : entries.flatMap(({ value }) => value?.type === "session_meta" && typeof value.payload?.cwd === "string" ? [value.payload.cwd] : []);
  if (!workspaces.length || workspaces.some((workspace) => resolve(workspace) !== cwd)) {
    fail(`unsupported or mismatched ${host} transcript at ${path}`);
  }
  for (const { line, value } of entries) {
    const item = value?.payload && typeof value.payload === "object" ? value.payload : value;
    const message = item?.message && typeof item.message === "object" ? item.message : item;
    const failure = host === "codex" ? codexToolError(item) : "";
    if (failure) records.push({ line, kind: "tool-error", text: failure });
    const role = message?.role;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const result of content.filter(({ type, is_error, isError } = {}) => type === "tool_result" && (is_error || isError))) {
        const output = text(result.content);
        if (output) records.push({ line, kind: "tool-error", text: output });
      }
    }
    const spoken = text(Array.isArray(content) ? content.filter(({ type } = {}) => type !== "tool_result") : content)
      || (typeof item?.message === "string" ? item.message : "");
    if (spoken && ["user", "developer"].includes(role)) records.push({ line, kind: "user", text: spoken });
    else if (spoken && role === "assistant") records.push({ line, kind: "assistant", text: spoken });
    else if (spoken && role === "tool" && (message?.is_error || message?.isError)) records.push({ line, kind: "tool-error", text: spoken });
    else if (typeof item?.summary === "string" && /summary|compact/.test(item.type ?? value.type ?? "")) records.push({ line, kind: "summary", text: item.summary });
  }
  if (!records.length || (main && !records.some(({ kind }) => kind === "user"))) fail(`unsupported ${host} transcript schema at ${path}`);
  return records;
}

function rootList(host, cwd) {
  const home = process.env.HOME || homedir();
  if (host === "cursor") {
    const documented = cwd.slice(1).replaceAll("/", "-");
    const observed = documented.replace(/[^A-Za-z0-9_-]/g, "-");
    return [...new Set([documented, observed].map((slug) => join(home, ".cursor", "projects", slug, "agent-transcripts")))];
  }
  if (host === "omp") {
    const configured = [process.env.PI_CODING_AGENT_SESSION_DIR, process.env.OMP_SESSION_DIR, process.env.OMP_SESSION_ROOT, process.env.PI_SESSION_DIR].filter(Boolean);
    if (process.env.PI_CODING_AGENT_DIR) configured.push(join(process.env.PI_CODING_AGENT_DIR, "sessions"));
    configured.push(join(home, ".omp", "agent", "sessions"));
    const profile = process.env.OMP_PROFILE !== undefined ? process.env.OMP_PROFILE : process.env.PI_PROFILE;
    if (process.env.XDG_DATA_HOME) {
      const dataRoot = profile && profile !== "default"
        ? join(process.env.XDG_DATA_HOME, "omp", "profiles", profile)
        : join(process.env.XDG_DATA_HOME, "omp");
      configured.push(join(dataRoot, "sessions"));
    }
    if (profile) {
      if (isAbsolute(profile)) configured.push(join(profile, "sessions"));
      else configured.push(join(home, ".omp", "profiles", profile, "agent", "sessions"));
    }
    return [...new Set(configured.map((path) => resolve(path)))];
  }
  if (host === "claude") return [join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects")];
  return [join(process.env.CODEX_HOME || join(home, ".codex"), "sessions")];
}

function requestedFile(host, request, roots, cwd) {
  const verified = (path) => existsSync(path) && roots.some((root) => existsSync(root) && inside(root, path));
  if (isAbsolute(request)) {
    const candidate = existsSync(request) && statSync(request).isDirectory()
      ? join(request, `${basename(request)}.jsonl`)
      : request;
    if (!existsSync(candidate)) fail(`cannot identify requested ${host} session: ${request}`);
    if (host === "cursor" && !verified(candidate)) fail(`path is outside the verified Cursor workspace root: ${request}; exported logs lack workspace metadata`);
    return realpathSync(candidate);
  }
  if (host === "cursor") {
    const matches = roots.map((root) => join(root, request, `${request}.jsonl`)).filter(verified);
    if (matches.length !== 1) fail(`cannot identify requested Cursor session: ${request}`);
    return realpathSync(matches[0]);
  }
  const candidates = new Set(roots.flatMap((root) => files(root, (path) => extname(path) === ".jsonl", 3)));
  const exact = [...new Set([...candidates].filter((path) => {
    if (!verified(path)) return false;
    const named = basename(path) === `${request}.jsonl`;
    try {
      let identified = false;
      let fallback = false;
      for (const value of jsonlPrefix(path)) {
        const item = host === "codex" ? (value?.type === "session_meta" ? value.payload : null)
          : host === "omp" ? (value?.type === "session" ? value : null) : value;
        if (!item) continue;
        const id = host === "claude" ? item.sessionId : item.id;
        if (item.isSidechain === true) {
          if (typeof id === "string") return false;
          continue;
        }
        if (typeof id === "string") {
          identified = true;
          // The first complete identity ends discovery; selected transcripts are still parsed in full.
          if (typeof item.cwd === "string") return id === request && resolve(item.cwd) === cwd;
        } else if (named && typeof item.cwd === "string" && resolve(item.cwd) === cwd) {
          fallback = true;
        }
      }
      return !identified && fallback;
    } catch (error) {
      if (named) throw error;
      return false;
    }
  }).map((path) => realpathSync(path)))];
  if (exact.length !== 1) fail(`cannot identify requested ${host} session: ${request}`);
  return realpathSync(exact[0]);
}

function evidence(host, cwd, requests) {
  const roots = rootList(host, cwd);
  const metadata = host === "cursor"
    ? process.env.CURSOR_SESSION_ID
    : host === "omp"
      ? process.env.OMP_SESSION_PATH || process.env.PI_CODING_AGENT_SESSION_FILE || process.env.OMP_SESSION_ID
      : host === "claude"
        ? process.env.CLAUDE_SESSION_ID
        : process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID;
  const selected = requests.length ? requests : metadata ? [metadata] : [];
  if (!selected.length) return { host, sessions: [], gaps: [`current ${host} session identity is unavailable; full history was not established`] };
  const paths = [...new Set(selected.map((request) => requestedFile(host, request, roots, cwd)))];
  const gaps = [];
  const sessions = paths.flatMap((path) => {
    if (host === "cursor") return cursorSession(path);
    if (host === "omp") return ompSession(path, cwd, gaps);
    const found = [{ path, records: genericRecords(path, host, true, cwd) }];
    if (host === "claude") {
      const childRoot = path.slice(0, -extname(path).length);
      for (const child of files(join(childRoot, "subagents"), (file) => extname(file) === ".jsonl")) {
        if (!inside(childRoot, child)) fail(`path is outside the verified Claude child root: ${child}`);
        const canonical = realpathSync(child);
        found.push({ path: canonical, records: genericRecords(canonical, host, false, cwd) });
      }
    }
    return found;
  });
  return { host, sessions, gaps };
}

try {
  const { values } = parseArgs({
    options: {
      host: { type: "string" },
      cwd: { type: "string" },
      session: { type: "string", multiple: true, default: [] },
    },
    strict: true,
  });
  if (!HOSTS.has(values.host)) fail(`unknown host: ${values.host ?? "missing"}`);
  if (!values.cwd || !isAbsolute(values.cwd)) fail("--cwd must be an absolute path");
  process.stdout.write(`${JSON.stringify(evidence(values.host, resolve(values.cwd), values.session))}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
