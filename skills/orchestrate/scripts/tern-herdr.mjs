#!/usr/bin/env node
// The Herdr commands orchestrate runs, served by Tern's CLI, for OMP workers that
// Tern draws natively. Output follows Herdr's JSON shapes; errors go to stderr
// as {"error":{code,message}} with exit 1, and anything outside this subset
// exits 2. See ../TERN.md.
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const DIR = process.env.SUPERMATT_TERN_HERDR_DIR || join(tmpdir(), "supermatt-tern-herdr");
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

// omp shows a paste in its composer, and empties the composer on Enter, within
// about 50ms (measured), but right after a turn it has taken five seconds; these
// bound the two waits, past any frames omp holds back.
const ECHO_MAX_MS = 10_000;
const SUBMIT_MAX_MS = 10_000;
const PROMPT_GATE_MS = 5000;
// zsh's ctrl+u clears one line of a multi-line input per press, and an extra
// press on an empty line does nothing; ctrl+c would clear it all at once, but it
// interrupts a shell still sourcing its rc file or running a cd hook.
const LINE_CLEARS = 300;
// A surface record no name holds is removed once it has been still this long:
// its omp has exited, or never started.
const ORPHAN_MS = 10 * 60_000;

// What a failed prompt left in omp's composer, for the caller to act on.
const NOTHING_TYPED = "nothing was typed";
const PASTE_UNSEEN = "the pasted text may sit in its composer or in the dialog, so read the pane before prompting again";
const TEXT_UNSENT = "the prompt text sits unsent in its composer, so clear it before prompting again";

class Failure extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
class Usage extends Error {}

// The caller's deadline for the wait in progress, which a retried read never
// outlasts.
let readsUntil;

function tern(...args) {
  const retryable = ["inspect", "process", "capture", "--version"].includes(args[0]);
  const budget = Date.now() + 60_000;
  const deadline = Math.min(budget, readsUntil ?? Infinity);
  let delay = 100;
  while (true) {
    const r = spawnSync("tern", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Failure("tern_failed", `tern ${args[0]}: ${r.error.message}`);
    if (r.status === 0) return r.stdout;
    const failed = new Failure("tern_failed", (r.stderr || `tern ${args[0]} exited ${r.status}`).trim());
    if (!retryable || r.signal || !/os error 35|Resource temporarily unavailable/.test(r.stderr || "")) throw failed;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw readsUntil <= budget ? timedOut() : failed;
    sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, 1000);
  }
}
const ternJson = (...args) => JSON.parse(tern(...args));

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const timedOut = () => new Failure("timeout", "timed out waiting for agent status");

// Polls fast at first, then once a second, so an hours-long wait stays cheap.
// A read the daemon is too busy to answer is retried until `readLimit`.
function poll(deadline, check, readLimit = deadline) {
  const started = Date.now();
  readsUntil = readLimit;
  try {
    for (;;) {
      const value = check();
      if (value !== undefined) return value;
      if (deadline !== undefined && Date.now() >= deadline) throw timedOut();
      const interval = Date.now() - started < 10_000 ? 250 : 1000;
      sleep(deadline === undefined ? interval : Math.max(0, Math.min(interval, deadline - Date.now())));
    }
  } finally {
    readsUntil = undefined;
  }
}

// ---- registry: agent names, display labels and surface records

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}
function writeJson(file, value) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}
const nameFile = (name) => join(DIR, "names", `${name}.json`);
const metaFile = (pane) => join(DIR, "meta", `${pane}.json`);
const RECORDS = join(DIR, "records");
const replayFile = (record) => join(DIR, "replays", `${basename(record)}.json`);
function names() {
  try {
    return readdirSync(join(DIR, "names")).filter((f) => f.endsWith(".json")).map((f) => ({ name: f.slice(0, -5), ...readJson(join(DIR, "names", f)) }));
  } catch { return []; }
}
function forget(name) {
  const entry = readJson(nameFile(name));
  rmSync(nameFile(name), { force: true });
  if (entry?.record) dropRecord(entry.record);
}
function dropRecord(record) {
  rmSync(record, { force: true });
  rmSync(replayFile(record), { force: true });
}

// ---- omp's surface, replayed from the record it writes
//
// A native omp draws its composer, its dialogs and its working row in the dock
// and the layer of its inline session surface, which no `tern capture` shows.
// Launched with PI_TUI_TSP_RECORD, omp appends every Surface Protocol message it
// sends or reads to a file; replaying the frames rebuilds the session's dock and
// layer, and every region of a full-screen surface omp opens over it. The
// replay is saved with the byte offset it reached, so each call reads only the
// messages written since.
//
// omp holds back its frames while two are unacknowledged, and Tern acknowledges
// only frames a window draws, so a pane out of sight (another tab, or a pane
// opened in one) gets its frames late: omp sends what it held once its oldest
// unacknowledged frame is five seconds old (measured). A replay taken while omp
// holds frames back may be that late, so `view` waits until omp has sent them.

const SESSION_REGIONS = new Set(["dock", "layer"]);
const SCREEN_REGIONS = new Set(["main", "dock", "layer"]);
const CREDITS = 2;
const ACK_TIMEOUT_MS = 5000;
const FLUSH_MARGIN_MS = 250;

// A surface kept from the record: its id, the nodes of its regions kept, and
// the frames omp sent it that Tern has not acknowledged.
const newSurface = (sf) => ({ sf, nodes: {}, unacked: [] });

function surface(record) {
  let fd;
  try { fd = openSync(record, "r"); } catch { return undefined; }
  try {
    const size = fstatSync(fd).size;
    let doc = readJson(replayFile(record));
    if (doc?.v !== 3 || doc.offset > size) doc = { v: 3, offset: 0, session: null, open: false, suspended: false, screens: {}, prompts: 0 };
    if (size > doc.offset) {
      const bytes = Buffer.alloc(size - doc.offset);
      readSync(fd, bytes, 0, bytes.length, doc.offset);
      const end = bytes.lastIndexOf(10);
      if (end >= 0) {
        for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) replay(doc, line);
        doc.offset += end + 1;
        writeJson(replayFile(record), doc);
      }
    }
    return doc;
  } finally {
    closeSync(fd);
  }
}

function replay(doc, line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { dir, verb, body, t } = message ?? {};
  if (!body) return;
  // omp counts a surface's frames as acknowledged once the oldest is ACK_TIMEOUT_MS old.
  for (const s of surfacesOf(doc)) if (s.unacked.length && t >= s.unacked[0].t + ACK_TIMEOUT_MS) s.unacked = [];
  const target = body.sf === doc.session?.sf ? doc.session : doc.screens[body.sf];
  if (dir === "in") {
    if (verb === "e" && body.ev === "ack" && target) target.unacked = target.unacked.filter((f) => f.s > body.s);
  } else if (dir !== "out") {
    return;
  } else if (verb === "o") {
    if (body.mode === "screen") doc.screens[body.id] = newSurface(body.id);
    else if (body.mode === "inline" && body.role === "omp.session") Object.assign(doc, { session: newSurface(body.id), open: true, suspended: false, screens: {} });
  } else if (verb === "x") {
    if (body.id === doc.session?.sf) doc.open = false;
    else delete doc.screens[body.id];
  } else if (verb === "f" && target && (target !== doc.session || doc.open)) {
    for (const op of body.ops || []) {
      if (target !== doc.session) apply(target, SCREEN_REGIONS, op);
      else if (op[0] === "suspend" || op[0] === "resume") doc.suspended = op[0] === "suspend";
      else {
        // A user message card in the chat: omp took a prompt as a turn.
        if (op[0] === "add" && op[2] === "main" && op[4]?.p?.role === "omp.user") doc.prompts += 1;
        apply(target, SESSION_REGIONS, op);
      }
    }
    target.unacked.push({ s: body.s, t });
  }
}

const surfacesOf = (doc) => [doc.session, ...Object.values(doc.screens)].filter(Boolean);

// Whether omp may still hold frames back for one of its surfaces.
function held(doc, now) {
  return doc.open && surfacesOf(doc).some((s) => s.unacked.length >= CREDITS && now < s.unacked[0].t + ACK_TIMEOUT_MS + FLUSH_MARGIN_MS);
}

// Applies one frame op to the nodes kept of `surface`: the subtrees of its
// `regions`, and nothing else.
function apply({ sf, nodes }, regions, op) {
  const [kind, id] = op;
  const node = nodes[id];
  if (kind === "add") {
    const [, , parent, before, tree] = op;
    if (node) drop(nodes, id);
    if (nodes[parent] || (parent === sf && regions.has(id))) graft(nodes, tree, parent, before);
  } else if (kind === "del") {
    if (node) drop(nodes, id);
  } else if (kind === "set") {
    if (node) for (const [key, value] of Object.entries(op[2] || {})) {
      if (value === null) delete node.p[key];
      else node.p[key] = value;
    }
  } else if (kind === "text") {
    if (node) node.p.text = op[2] === "append" ? (node.p.text ?? "") + op[3] : op[3];
  } else if (kind === "splice") {
    if (node) { const text = node.p.text ?? ""; node.p.text = text.slice(0, op[2]) + op[4] + text.slice(op[2] + op[3]); }
  } else if (kind === "move") {
    if (!node) return;
    if (!nodes[op[2]]) { drop(nodes, id); return; }
    detach(nodes, id);
    attach(nodes, id, op[2], op[3]);
  }
}
function graft(nodes, tree, parent, before) {
  nodes[tree.id] = { k: tree.k, p: { ...tree.p }, c: [], parent };
  if (nodes[parent]) attach(nodes, tree.id, parent, before);
  for (const child of tree.c || []) graft(nodes, child, tree.id, null);
}
function attach(nodes, id, parent, before) {
  nodes[id].parent = parent;
  const siblings = nodes[parent].c;
  const at = before === null ? -1 : siblings.indexOf(before);
  if (at < 0) siblings.push(id);
  else siblings.splice(at, 0, id);
}
function detach(nodes, id) {
  const parent = nodes[nodes[id].parent];
  if (parent) parent.c = parent.c.filter((c) => c !== id);
}
function drop(nodes, id) {
  for (const child of nodes[id].c) drop(nodes, child);
  detach(nodes, id);
  delete nodes[id];
}

// The visible nodes under `id`, depth first; a hidden node hides its subtree.
function* visible(nodes, id) {
  const node = nodes[id];
  if (!node || node.p.hidden) return;
  yield [id, node];
  for (const child of node.c) yield* visible(nodes, child);
}

// What omp's surface says. Blocked: a dialog in the composer's place
// (omp.editor.<kind>), a sheet in the layer (omp.overlay.<name>, such as the
// plan review), or a full-screen surface. Working: the working row, or a
// composer that cannot take a prompt yet. Idle: a sendable composer alone. A
// closed session surface is an omp on its way out. It waits for frames omp
// holds back, but at most ACK_TIMEOUT_MS + FLUSH_MARGIN_MS from the call: the
// frames held then reach the record by that time, so the view is never older
// than the call, and a worker that keeps drawing out of sight cannot hold the
// read for longer.
function view(record) {
  let doc = surface(record);
  const giveUp = Date.now() + ACK_TIMEOUT_MS + FLUSH_MARGIN_MS;
  while (doc && held(doc, Date.now()) && Date.now() < giveUp) {
    sleep(50);
    doc = surface(record);
  }
  if (!doc) return { record, status: "unknown", reason: `it has written no surface record at ${record}` };
  if (!doc.session) return { record, status: "unknown", reason: "it has not opened its surface yet" };
  if (!doc.open) return { record, status: "exited", doc };
  if (doc.suspended) return { record, status: "unknown", reason: "it has handed its pane back to the terminal", doc };
  const { nodes } = doc.session;
  let dialog = Object.keys(doc.screens).length > 0, working = false, editor;
  for (const [id, node] of visible(nodes, "dock")) {
    const role = node.p.role ?? "";
    if (role.startsWith("omp.editor.")) dialog = true;
    else if (role === "omp.working") working = true;
    else if (role === "omp.editor") editor = [...visible(nodes, id)].find(([, n]) => n.k === "editor")?.[1];
  }
  for (const [, node] of visible(nodes, "layer")) if ((node.p.role ?? "").startsWith("omp.overlay.")) dialog = true;
  const status = dialog ? "blocked" : working || editor?.p.sendable !== true ? "working" : "idle";
  return { record, status, composer: editor ? editor.p.text ?? "" : undefined, prompts: doc.prompts, doc };
}

// ---- what the capture leaves out, as text, the way it reads on screen
//
// The session's dock and layer, then any full-screen surface: one line per
// block, a row on one line, `›` on a list's highlighted item, [x] or [ ] on a
// check option, a control's own title (its label and key hint) for the
// control, and `> ` before the composer's text.

const spansText = (spans) => (Array.isArray(spans) ? spans.map((s) => (typeof s === "string" ? s : s?.t ?? "")).join("") : typeof spans === "string" ? spans : "");
const SILENT = new Set(["spinner", "elapsed", "rate", "effort", "icon", "image", "spacer", "toast", "progress"]);

function lines(nodes, id) {
  const node = nodes[id];
  if (!node || node.p.hidden || SILENT.has(node.k)) return [];
  const { p } = node;
  const children = () => node.c.flatMap((child) => lines(nodes, child));
  switch (node.k) {
    case "tabs": {
      const items = (p.items || []).map((item) => `${item.id === p.active ? "›" : " "}${spansText(item.label)}`);
      return [`${items.join("  ")}${p.title ? `   (${p.title})` : ""}`];
    }
    case "list":
      return node.c.flatMap((child) => (nodes[child] && !nodes[child].p.hidden ? [item(nodes[child], child === p.selected)] : []));
    case "item":
      return [item(node, false)];
    case "kv":
      return (p.items || []).map((entry) => `${spansText(entry.k)}: ${spansText(entry.v)}`);
    case "kbd":
      return [`[${(p.keys || []).join("+")}]`];
    case "editor": case "input":
      return p.text ? String(p.text).split("\n").map((l) => `> ${l}`) : [];
    case "meter":
      return p.label ? [spansText(p.label)] : [];
  }
  if (p.actions?.click && p.title) return [`[${p.title}]`];
  if (node.k === "row" || node.k === "status" || node.k === "seg") {
    const parts = node.c.map((child) => lines(nodes, child));
    if (parts.some((part) => part.length > 1)) return parts.flat();
    return [[spansText(p.spans), ...parts.flat()].filter((s) => s.trim()).join("  ")];
  }
  const own = p.text ?? (p.spans ? spansText(p.spans) : p.label ? spansText(p.label) : "");
  return [...(own ? String(own).split("\n") : []), ...children()];
}
function item(node, selected) {
  const role = node.p.role ?? "";
  const check = role.endsWith(".check") ? (node.p.icon === "check" ? "[x] " : "[ ] ") : "";
  const detail = node.p.detail ? `  ${spansText(node.p.detail)}` : "";
  return `${selected ? "›" : " "} ${check}${spansText(node.p.label)}${detail}`;
}
function render(doc) {
  const screens = Object.values(doc.screens).flatMap(({ nodes }) => [...SCREEN_REGIONS].flatMap((region) => lines(nodes, region)));
  return [...lines(doc.session.nodes, "dock"), ...lines(doc.session.nodes, "layer"), ...screens].filter((l) => l.trim());
}

// ---- Tern state

function snapshot() {
  const inspect = ternJson("inspect", "--json");
  const tabs = new Map();
  for (const session of inspect.sessions || []) for (const tab of session.tabs || []) for (const block of tab.blocks || []) tabs.set(String(block.id), String(tab.id));
  return { panes: new Map((inspect.panes || []).map((p) => [String(p.pane), p])), tabs };
}

function foreground(pane) {
  const proc = ternJson("process", pane, "--json");
  return { child: proc.child, fg: proc.foreground };
}
const isOmp = (proc) => !!proc?.argv?.length && basename(proc.argv[0]) === "omp";

// Internal to an agent object: the surface view it was read with. A symbol key
// stays out of the JSON a command prints, and object spread copies it.
const SURFACE = Symbol("surface");
// Only process-query failures whose pane still exists may be tolerated by
// launch readiness and the post-keys reread; inspect failures stay unmarked.
const PROCESS_QUERY_FAILED = Symbol("process query failed");

// The agent in a pane right now, or undefined when its foreground is not omp.
// An omp `agent start` launched is read from its surface record (`record`, or
// the one its name holds); any other omp, the orchestrator's own pane among
// them, only from Tern's working flag.
function agentIn(pane, snap = snapshot(), record) {
  const info = snap.panes.get(pane);
  if (!info) return undefined;
  let fg;
  try { ({ fg } = foreground(pane)); } catch (e) {
    if (e.code === "timeout") throw e;
    if (!snapshot().panes.has(pane)) return undefined;
    e[PROCESS_QUERY_FAILED] = true;
    throw e;
  }
  if (!isOmp(fg)) return undefined;
  const named = names().find((n) => n.pane === pane && n.pid === fg.pid);
  const surfaceView = record || named?.record ? view(record || named.record) : undefined;
  const meta = readJson(metaFile(pane));
  const agent = {
    agent: "omp",
    ...(named ? { name: named.name } : {}),
    ...(meta?.display_agent ? { display_agent: meta.display_agent } : {}),
    agent_status: !surfaceView ? (info.working ? "working" : "idle") : surfaceView.status === "exited" ? "unknown" : surfaceView.status,
    ...(info.omp_session_file ? { agent_session: { agent: "omp", kind: "path", source: "tern", value: info.omp_session_file } } : {}),
    cwd: info.cwd,
    pane_id: pane,
    tab_id: snap.tabs.get(pane),
    terminal_title: info.title,
    pid: fg.pid,
  };
  if (surfaceView) agent[SURFACE] = surfaceView;
  return agent;
}

// A target is a live agent name or a pane id hosting an agent. A name whose omp
// has left its pane is cleared, so it never follows a later occupant of the pane.
function resolve(target) {
  const snap = snapshot();
  const entry = NAME.test(target) ? readJson(nameFile(target)) : undefined;
  if (entry) {
    const agent = agentIn(entry.pane, snap);
    if (agent && agent.pid === entry.pid) return agent;
    if (snap.panes.has(entry.pane) && left(entry)) forget(target);
  } else {
    const agent = agentIn(target, snap);
    if (agent) return agent;
  }
  throw new Failure("agent_not_found", `agent target ${target} not found`);
}

// The pid Tern shows in the foreground of `pane` (null for none), or undefined
// when Tern does not show the pane or `tern process` fails.
function foregroundPid(pane) {
  try { return foreground(pane).fg?.pid ?? null; } catch { return undefined; }
}
// Whether the omp a name holds has left its pane: Tern shows the pane running
// another process. A pane Tern does not show, or a `tern process` that fails,
// proves nothing.
function left(entry) {
  const pid = foregroundPid(entry.pane);
  return pid !== undefined && pid !== entry.pid;
}

function checkName(name) {
  if (!NAME.test(name)) throw new Failure("invalid_agent_name", `agent name ${name} must match ${NAME.source.slice(1, -1)}`);
}

// Fails when an omp process other than `agent`'s still holds the name.
function assertNameFree(name, agent) {
  const holder = readJson(nameFile(name));
  if (!holder || (agent && holder.pane === agent.pane_id && holder.pid === agent.pid)) return;
  const live = agentIn(holder.pane);
  if (live && live.pid === holder.pid) throw new Failure("agent_name_in_use", `agent name ${name} is already in use`);
}

function claim(name, agent) {
  assertNameFree(name, agent);
  const record = agent[SURFACE]?.record;
  for (const n of names()) if (n.pane === agent.pane_id && n.name !== name) {
    rmSync(nameFile(n.name), { force: true });
    if (n.record && n.record !== record) dropRecord(n.record);
  }
  writeJson(nameFile(name), { pane: agent.pane_id, pid: agent.pid, ...(record ? { record } : {}) });
  return { ...agent, name };
}

// Clears each name whose omp has left its pane, with its record, then removes
// the records no name holds once they have been still for ORPHAN_MS: an omp
// that never came up, or one whose name was cleared before it exited. A name
// whose pane Tern does not find here (closed, or in another window's sessions)
// is cleared only once its record has been still that long too.
function sweepRecords() {
  for (const n of names()) {
    if (!n.record) continue;
    const pid = foregroundPid(n.pane);
    if (pid === undefined ? still(n.record) : pid !== n.pid) forget(n.name);
  }
  const held = new Set(names().map((n) => n.record).filter(Boolean));
  let files;
  try { files = readdirSync(RECORDS); } catch { return; }
  for (const f of files) {
    const record = join(RECORDS, f);
    if (!held.has(record) && still(record)) dropRecord(record);
  }
}
function still(record) {
  try { return Date.now() - statSync(record).mtimeMs > ORPHAN_MS; } catch { return true; }
}

// ---- arguments

function parse(args, spec) {
  const flags = {}, positional = [];
  let rest;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { rest = args.slice(i + 1); break; }
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const key = a.slice(2);
    if (!(key in spec)) throw new Usage(`unsupported flag ${a}`);
    if (spec[key] === "bool") flags[key] = true;
    else {
      if (i + 1 >= args.length) throw new Usage(`${a} needs a value`);
      const value = args[++i];
      if (spec[key] === "list") (flags[key] ||= []).push(value);
      else flags[key] = value;
    }
  }
  return { flags, positional, rest };
}
function one(positional, what) {
  if (positional.length !== 1) throw new Usage(`expected ${what}`);
  return positional[0];
}
function none(positional) {
  if (positional.length) throw new Usage(`unexpected argument ${positional[0]}`);
}
const ms = (value) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Usage(`invalid timeout ${value}`);
  return n;
};

const quote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

// ---- commands

const KINDS = "kinds: omp (served by Tern; other kinds need Herdr)";

const commands = {
  "pane split"(args) {
    const { flags, positional } = parse(args, { direction: "value", ratio: "value", cwd: "value", "no-focus": "bool" });
    const target = one(positional, "<pane_id>");
    if (!["right", "down"].includes(flags.direction)) throw new Usage("--direction must be right or down");
    const made = ternJson("split", target, flags.direction, ...(flags.cwd ? ["--cwd", flags.cwd] : []), "--json");
    return { pane: { pane_id: String(made.block), tab_id: String(made.tab), ...(flags.cwd ? { cwd: flags.cwd } : {}) } };
  },
  "pane run"(args) {
    const { positional } = parse(args, {});
    if (positional.length !== 2) throw new Usage("pane run <pane_id> <command>");
    tern("run", positional[0], positional[1]);
    return { pane_id: positional[0] };
  },
  "pane close"(args) {
    const pane = one(parse(args, {}).positional, "<pane_id>");
    tern("close", pane);
    return { pane_id: pane };
  },
  "pane report-metadata"(args) {
    const { flags, positional } = parse(args, { source: "value", "display-agent": "value" });
    const pane = one(positional, "<pane_id>");
    if (!flags.source) throw new Usage("--source is required");
    const meta = readJson(metaFile(pane)) || {};
    if (flags["display-agent"] !== undefined) meta.display_agent = flags["display-agent"];
    writeJson(metaFile(pane), meta);
    return { pane_id: pane };
  },
  // Tern renames a tab through one of its blocks, so a tab id is turned into the
  // first block of that tab; a block id (TERN.md's $HERDR_TAB_ID) passes as is.
  "tab rename"(args) {
    const { positional } = parse(args, {});
    if (positional.length !== 2) throw new Usage("tab rename <tab_id> <label>");
    const { panes, tabs } = snapshot();
    const block = panes.has(positional[0]) ? positional[0] : [...tabs].find(([, tab]) => tab === positional[0])?.[0];
    if (!block) throw new Failure("tab_not_found", `tab ${positional[0]} not found`);
    tern("rename", block, positional[1]);
    return { tab_id: positional[0], label: positional[1] };
  },
  "agent list"(args) {
    none(parse(args, {}).positional);
    const snap = snapshot();
    return { agents: [...snap.panes.keys()].map((pane) => agentIn(pane, snap)).filter(Boolean) };
  },
  "agent get"(args) {
    return { agent: resolve(one(parse(args, {}).positional, "<target>")) };
  },
  "agent rename"(args) {
    const { positional } = parse(args, {});
    if (positional.length !== 2) throw new Usage("agent rename <target> <name>");
    checkName(positional[1]);
    return { agent: claim(positional[1], resolve(positional[0])) };
  },
  "agent start"(args) {
    if (args.length === 1 && args[0] === "--help") return print(`Start a supported interactive agent in an existing pane\n\nUsage: herdr agent start <NAME> --kind <KIND> --pane <ID> [OPTIONS] [-- [AGENT_ARG]...]\n\n${KINDS}\n`);
    const { flags, positional, rest = [] } = parse(args, { kind: "value", pane: "value", timeout: "value" });
    const name = one(positional, "<name>");
    const timeout = ms(flags.timeout) ?? 30_000;
    if (!flags.pane) throw new Usage("--pane is required");
    if (flags.kind !== "omp") throw new Failure("unsupported_agent_kind", `agent kind ${flags.kind} is not supported in Tern; ${KINDS}`);
    checkName(name);
    assertNameFree(name);
    const pane = flags.pane;
    const { child, fg } = foreground(pane);
    if (!fg || fg.pid !== child?.pid) throw new Failure("agent_pane_busy", `pane ${pane} is not at its shell prompt`);
    sweepRecords();
    mkdirSync(RECORDS, { recursive: true });
    const record = join(RECORDS, `${pane}-${Date.now()}-${process.pid}.jsonl`);
    // The ctrl+u presses discard the input line, where a keystroke meant for an
    // omp that just exited would otherwise run ahead of the launch.
    tern("send", pane, "keys", ...Array(LINE_CLEARS).fill("ctrl+u"));
    tern("run", pane, ["PI_TUI_NATIVE=1", `PI_TUI_TSP_RECORD=${quote(record)}`, "omp", ...rest.map(quote)].join(" "));
    let found;
    try {
      found = poll(Date.now() + timeout, () => {
        const snap = snapshot();
        try {
          const a = agentIn(pane, snap, record);
          return a && (a.agent_status === "idle" || a.agent_status === "blocked") ? a : undefined;
        } catch (e) {
          if (!e[PROCESS_QUERY_FAILED]) throw e;
          return undefined;
        }
      });
    } catch (e) {
      if (e.code === "timeout") throw new Failure("timeout", `omp in pane ${pane} showed no composer ready for a prompt within ${timeout}ms (surface record ${record})`);
      throw e;
    }
    const named = claim(name, found);
    if (found.agent_status === "blocked") throw new Failure("agent_not_ready", `agent ${name} is waiting at a dialog; read it and answer with send-keys`);
    return { agent: named };
  },
  "agent prompt"(args) {
    const { flags, positional } = parse(args, { wait: "bool", until: "list", timeout: "value" });
    if (positional.length !== 2) throw new Usage("agent prompt <target> <text>");
    const deadline = deadlineOf(flags.timeout);
    const until = untilOf(flags.until);
    const agent = resolve(positional[0]);
    const who = agent.name ?? agent.pane_id;
    checkTypable(agent, NOTHING_TYPED);
    const before = agent[SURFACE];
    if (!before) throw new Failure("agent_state_hidden", `omp in pane ${agent.pane_id} was not launched by agent start, so its composer cannot be read; ${NOTHING_TYPED}`);
    if (before.composer) throw new Failure("agent_not_ready", `agent ${who}'s composer already holds unsent text; ${NOTHING_TYPED}; clear it with agent send-keys ${who} ctrl+u, one line per press, until agent read shows no "> " line`);
    tern("send", agent.pane_id, "paste", positional[1]);
    // omp shows the paste in its composer: the text, or a chip for a long one.
    let pasted;
    try {
      pasted = awaitTypable(agent, ECHO_MAX_MS, (s) => !!s.composer);
      assertTypable(agent, pasted.composer ? TEXT_UNSENT : PASTE_UNSEEN);
    } catch (e) {
      if (e.code === "tern_failed") throw new Failure(e.code, `${e.message}; ${pasted?.composer ? `${TEXT_UNSENT}; read the pane before prompting again` : PASTE_UNSEEN}`);
      throw e;
    }
    if (!pasted.composer) throw new Failure("agent_prompt_stalled", `agent ${who} showed no paste in its composer within ${ECHO_MAX_MS}ms; ${PASTE_UNSEEN}`);
    tern("send", agent.pane_id, "keys", "Enter");
    // An emptied composer means omp took the prompt. A dialog or an exit right
    // after the Enter means the same: the composer was gone or empty for it.
    let sent;
    try {
      sent = awaitTypable(agent, SUBMIT_MAX_MS, (s) => !s.composer, true);
    } catch (e) {
      if (e.code === "tern_failed") throw new Failure(e.code, `${e.message}; ${PASTE_UNSEEN}`);
      throw e;
    }
    if (sent.composer) throw new Failure("agent_prompt_stalled", `agent ${who} kept the prompt in its composer after Enter; ${TEXT_UNSENT}`);
    if (!flags.wait) return { agent };
    // Herdr's gate: a prompt sent to an agent that is not working must show
    // activity within five seconds, or it probably never landed. A user message
    // in the chat counts too, since a short turn can start and end within frames
    // omp held back.
    if (agent.agent_status !== "working") {
      const gate = Math.min(deadline ?? Infinity, Date.now() + PROMPT_GATE_MS);
      try {
        poll(gate, () => {
          const now = current(agent);
          return ["working", "blocked"].includes(now.agent_status) || now[SURFACE].prompts > before.prompts ? true : undefined;
        }, deadline ?? Infinity);
      } catch (e) {
        if (e.code === "timeout" && Date.now() < (deadline ?? Infinity)) throw new Failure("agent_prompt_stalled", `agent ${who} showed no activity within ${PROMPT_GATE_MS}ms of the prompt`);
        if (e.code === "tern_failed") throw new Failure(e.code, `${e.message}; ${PASTE_UNSEEN}`);
        throw e;
      }
    }
    try {
      return { agent: settle(agent, until, deadline, true) };
    } catch (e) {
      if (e.code === "tern_failed") throw new Failure(e.code, `${e.message}; ${PASTE_UNSEEN}`);
      throw e;
    }
  },
  "agent wait"(args) {
    const { flags, positional } = parse(args, { until: "list", timeout: "value" });
    const agent = resolve(one(positional, "<target>"));
    return { agent: settle(agent, untilOf(flags.until), deadlineOf(flags.timeout), false) };
  },
  "agent read"(args) {
    const { flags, positional } = parse(args, { source: "value", lines: "value", format: "value" });
    const source = flags.source ?? "recent";
    if (!["visible", "recent", "recent-unwrapped"].includes(source)) throw new Usage(`unknown --source ${source}`);
    if (![undefined, "text"].includes(flags.format)) throw new Usage(`unsupported --format ${flags.format}: Tern's ANSI capture leaves out omp's native drawing`);
    const n = flags.lines === undefined ? undefined : Number(flags.lines);
    if (n !== undefined && (!Number.isInteger(n) || n < 0)) throw new Usage(`invalid --lines ${flags.lines}`);
    const agent = resolve(one(positional, "<target>"));
    const text = tern("capture", agent.pane_id, "--surfaces", ...(source === "visible" ? [] : ["--scrollback"]));
    const out = text.split("\n");
    if (out.at(-1) === "") out.pop();
    const doc = agent[SURFACE]?.doc;
    if (doc && agent[SURFACE].status !== "exited") out.push(...render(doc));
    process.stdout.write(out.slice(n === undefined ? 0 : Math.max(0, out.length - n)).map((l) => `${l}\n`).join(""));
    return undefined;
  },
  "agent send-keys"(args) {
    const { positional } = parse(args, {});
    if (positional.length < 2) throw new Usage("agent send-keys <target> <key>...");
    const agent = resolve(positional[0]);
    const keys = positional.slice(1).map(ternKey);
    tern("send", agent.pane_id, "keys", ...keys);
    // The record shows a key's effect some 40ms after it lands; returning first
    // would let the next wait read the closed dialog as blocked.
    if (agent.agent_status === "blocked") {
      const end = Date.now() + 1000;
      // The keys have landed by now: a worker the answer left stateless, or an
      // omp the answer ended, is the next call's to report.
      try {
        while (Date.now() < end && current(agent).agent_status === "blocked") sleep(50);
      } catch (e) {
        if (!e[PROCESS_QUERY_FAILED] && e.code !== "agent_state_hidden" && e.code !== "agent_not_found") throw e;
      }
    }
    return { pane_id: agent.pane_id, keys };
  },
  "integration status"(args) {
    none(parse(args, {}).positional);
    return print(`omp: current (${tern("--version").trim()}, built into Tern) (${new URL(import.meta.url).pathname})\n`);
  },
};

// `unknown` is reported by agent get but never awaited: a wait on it fails at once.
const STATUSES = ["idle", "working", "blocked", "done"];
function untilOf(list) {
  for (const s of list || []) if (!STATUSES.includes(s)) throw new Usage(`unknown --until ${s}`);
  return list?.length ? list : ["idle", "done", "blocked"];
}
function deadlineOf(timeout) {
  const n = ms(timeout);
  return n === undefined ? undefined : Date.now() + n;
}

// The same agent, read again. It fails once that omp process has left the pane
// or closed its surface.
function reread(agent) {
  const now = agentIn(agent.pane_id);
  if (!now || now.pid !== agent.pid || now[SURFACE]?.status === "exited") throw exited(agent);
  return agent.name ? { ...now, name: agent.name } : now;
}
// As `reread`, and it also fails once the worker stops showing its state, since
// no wait could then settle.
function current(agent) {
  const now = reread(agent);
  if (now.agent_status === "unknown") throw stateHidden(now);
  return now;
}

const exited = (agent) => new Failure("agent_not_found", `agent ${agent.name ?? agent.pane_id} exited`);
const stateHidden = (agent, note) => new Failure("agent_state_hidden", `omp in pane ${agent.pane_id} shows no state: ${agent[SURFACE]?.reason ?? "its surface cannot be read"}${note ? `; ${note}` : ""}`);

// Refuses input to an agent at a dialog or showing no state, saying what its
// composer holds. An omp that exited took its composer along.
function checkTypable(agent, note) {
  if (agent[SURFACE]?.status === "exited") throw exited(agent);
  if (agent.agent_status === "unknown") throw stateHidden(agent, note);
  if (agent.agent_status === "blocked") throw new Failure("agent_blocked", `agent ${agent.name ?? agent.pane_id} is at a dialog; ${note}; read the dialog before sending input`);
}
// The worker right before a keystroke: the same omp, showing its state, and no
// dialog. It throws agent_not_found once omp has left, so a shell never gets the keys.
function assertTypable(agent, note) {
  checkTypable(reread(agent), note);
}
// Re-reads the worker until `ready(surface)` or for `max` ms, and returns the
// last surface view. It stops at once when the worker can no longer take keys;
// with `left` an omp that exits or closes its surface ends the wait too.
function awaitTypable(agent, max, ready, left = false) {
  const end = Date.now() + max;
  for (;;) {
    let now;
    try {
      now = reread(agent);
    } catch (e) {
      if (left && e.code === "agent_not_found") return { composer: undefined, status: "exited" };
      throw e;
    }
    const s = now[SURFACE];
    if (ready(s) || now.agent_status === "blocked" || now.agent_status === "unknown" || Date.now() >= end) return s;
    sleep(20);
  }
}

// Waits for one of `until`. A ready agent reads as "done" once this wait has
// seen it work (Herdr's unseen completion), and as "idle" otherwise.
function settle(agent, until, deadline, seen) {
  return poll(deadline, () => {
    const now = current(agent);
    if (now.agent_status === "working" || now.agent_status === "blocked") seen = true;
    const reported = now.agent_status === "idle" && seen ? "done" : now.agent_status;
    return until.includes(reported) ? { ...now, agent_status: reported } : undefined;
  });
}

const NAMED_KEYS = { esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: "Space", backspace: "Backspace", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", delete: "Delete", insert: "Insert" };

// Herdr's logical key names (esc, ctrl+c, shift+tab) as Tern spells them. Tern
// reads an uppercase letter as shift plus that letter, so a modified letter is
// lowered: ctrl+C is ctrl+c, as in Herdr.
function ternKey(key) {
  const parts = key.split("+");
  const base = parts.pop();
  const mods = parts.map((m) => m.toLowerCase());
  const lower = base.toLowerCase();
  const mapped = NAMED_KEYS[lower] ?? (/^f([1-9]|1[0-2])$/.test(lower) ? lower.toUpperCase() : [...base].length === 1 ? (mods.length ? lower : base) : undefined);
  if (!mapped || mods.some((m) => !["ctrl", "alt", "shift"].includes(m))) throw new Failure("invalid_key", `unsupported key ${key}`);
  return [...mods, mapped].join("+");
}

function print(text) {
  process.stdout.write(text);
  return undefined;
}

function main(argv) {
  const key = argv.slice(0, 2).join(" ");
  const id = `cli:${argv[0]}:${argv[1]}`;
  try {
    const command = commands[key];
    if (!command) throw new Usage(`unsupported command: herdr ${argv.join(" ")}`);
    const result = command(argv.slice(2));
    if (result !== undefined) process.stdout.write(`${JSON.stringify({ id, result })}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      process.stderr.write(`tern-herdr: ${e.message}\nsupported: ${Object.keys(commands).join(", ")}\n`);
      return 2;
    }
    const code = e instanceof Failure ? e.code : "internal_error";
    process.stderr.write(`${JSON.stringify({ error: { code, message: e.message }, id })}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
