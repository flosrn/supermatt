import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = fileURLToPath(new URL("../skills/orchestrate/scripts/tern-herdr.mjs", import.meta.url));

// Each test runs the shim several times, and some wait on purpose (the shim
// gives omp ten seconds to show a paste), past the five seconds bun allows a
// test by default.
const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);

// A stand-in for the `tern` CLI over one world file: panes with a title, a
// foreground process, a session file and captured text. A pane where `tern run`
// launches omp (from `launch`) gets a native omp that writes its Surface
// Protocol record where PI_TUI_TSP_RECORD says, as omp does: the session
// surface, a dock with the HUD (b) and the editor slot (e) holding the
// composer, Tern's acks (none with `launch.unacked`), and frames for what keys
// and pastes do. Per `inspect`, a pane's `states` queue moves omp to its next
// state (idle, working, blocked, exit, suspend; null keeps it); `afterEnter`
// replaces that queue when Enter submits a prompt (which also adds the user's
// message card to the chat, or an omp.skill card with an omp.skill.prompt child
// when `skillCard` is set) or answers the dialog. `statesAfterPaste` replaces
// it at a paste, `echoDelayMs` and `submitDelayMs` have omp write a paste's or
// an Enter's frame that many milliseconds later. `turnDelayMs` holds the card
// and working row back after the composer empties, without advancing `states`
// before that delayed frame lands. `pasteLost` and `enterLost` make omp ignore
// them, `noTurn` makes an Enter empty the composer and start nothing,
// `exitOnEnter` ends omp at the next Enter, and `processFails` fails that many
// `tern process` calls. A world's `failure` fails `remaining` calls
// of its `command` with its `message`, after letting `skip` of them succeed.
// `failureAfterRun`, `failureAfterPaste` and `failureAfterEnter` arm that same
// mechanism at the named stage; a failure's `after` arms the next failure
// when it fires, including an inspect failure after a failed process query.
const FAKE_TERN = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_TERN_WORLD;
const w = JSON.parse(fs.readFileSync(file, "utf8"));
const a = process.argv.slice(2);
w.calls.push(a);
const save = () => fs.writeFileSync(file, JSON.stringify(w));
const fail = (m) => { save(); process.stderr.write("tern " + a[0] + ": " + m + "\\n"); process.exit(1); };
if (w.failure && a[0] === w.failure.command && w.failure.remaining > 0) {
  if (w.failure.skip > 0) w.failure.skip -= 1;
  else {
    const failure = w.failure;
    failure.remaining -= 1;
    if (failure.after) w.failure = failure.after;
    fail(failure.message);
  }
}
const pane = (id) => w.panes[id] || fail("no block " + id);
const out = (v) => { save(); process.stdout.write(typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\\n"); process.exit(0); };
const write = (o, msg) => { if (o.record) fs.appendFileSync(o.record, JSON.stringify({ t: Date.now(), params: null, ...msg }) + "\\n"); };
// Writes a frame of ops and Tern's ack, at once or from a detached process
// delay ms later, as omp does when it is slow to react.
function frame(o, ops, delay = 0) {
  o.s += 1;
  if (!o.record) return;
  const t = Date.now() + delay;
  const lines = [{ t, params: null, dir: "out", verb: "f", body: { sf: "s:1", s: o.s, ops } }];
  if (!o.unacked) lines.push({ t, params: null, dir: "in", verb: "e", body: { ev: "ack", sf: "s:1", s: o.s } });
  const text = lines.map((l) => JSON.stringify(l) + "\\n").join("");
  if (!delay) fs.appendFileSync(o.record, text);
  else require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').appendFileSync(" + JSON.stringify(o.record) + ", " + JSON.stringify(text) + "), " + delay + ")"], { detached: true, stdio: "ignore" }).unref();
}
const composer = (o) => ({ id: "j", k: "col", p: { role: "omp.editor" }, c: [{ id: "j.line", k: "row", c: [{ id: "j.line/input", k: "editor", p: { text: o.text, sendable: o.sendable } }] }] });
const dialog = () => ({ id: "u", k: "col", p: { role: "omp.editor.ask" }, c: [
  { id: "u.question", k: "md", p: { text: "Pick a color:" } },
  { id: "u.q0", k: "list", p: { selected: "u.q0/option:0" }, c: [
    { id: "u.q0/option:0", k: "item", p: { label: [{ t: "Red" }], role: "omp.ask.option" } },
    { id: "u.q0/option:1", k: "item", p: { label: [{ t: "Blue" }], role: "omp.ask.option" } }] },
  { id: "u.submit", k: "row", p: { role: "omp.btn", title: "Submit  enter", actions: { click: "submit" } }, c: [{ id: "u.submit/0", k: "text", p: { text: "Submit" } }] }] });
const workingRow = { id: "q", k: "row", p: { role: "omp.working" }, c: [{ id: "q.label", k: "shimmer", p: { spans: [{ t: "Thinking" }] } }] };
function become(p, state) {
  const o = p.omp;
  if (state === "exit") { write(o, { dir: "out", verb: "x", body: { id: "s:1", keep: true } }); o.state = "exited"; p.foreground = p.child; return; }
  if (state === "suspend") { frame(o, [["suspend"]]); return; }
  const ops = [];
  if (state === "blocked" && o.state !== "blocked") ops.push(["add", "u", "e", null, dialog()], ["del", "j"]);
  if (state !== "blocked" && o.state === "blocked") ops.push(["add", "j", "e", null, composer(o)], ["del", "u"]);
  if (state === "working" && !o.working) { ops.push(["add", "q", "b", null, workingRow]); o.working = true; }
  if (state === "idle" && o.working) { ops.push(["del", "q"]); o.working = false; }
  if (state === "idle" && !o.sendable) { o.sendable = true; ops.push(["set", "j.line/input", { sendable: true }]); }
  o.state = state;
  frame(o, ops);
}
const shell = (pid) => ({ pid, name: "zsh", argv: ["/bin/zsh"], cwd: "/repo" });
const ompFg = (p) => p.omp && p.omp.state !== "exited" && p.foreground && p.foreground.pid !== p.child.pid;
function submit(p, delay) {
  const o = p.omp;
  const text = o.text;
  o.text = "";
  const ops = [["text", "j.line/input", "replace", ""]];
  if (!p.noTurn) {
    p.prompts = (p.prompts || 0) + 1;
    const id = "p" + p.prompts;
    const card = p.skillCard
      ? { id, k: "card", p: { role: "omp.skill" }, c: [{ id: id + ".prompt", k: "md", p: { role: "omp.skill.prompt", text } }] }
      : { id, k: "card", p: { role: "omp.user" } };
    ops.push(["add", id, "main", null, card]);
    if (!o.working) { ops.push(["add", "q", "b", null, workingRow]); o.working = true; o.state = "working"; }
    p.states = [...(p.afterEnter || ["idle"])];
    delete p.afterEnter;
  }
  if (p.turnDelayMs && !p.noTurn) {
    frame(o, ops.splice(0, 1), delay);
    frame(o, ops, delay + p.turnDelayMs);
  } else frame(o, ops, delay);
  o.submitted = o.s;
}
// Whether omp's last submit frame (none: nothing pending) has reached its record.
function landed(o) {
  if (o.submitted === undefined || !o.record) return true;
  const done = fs.readFileSync(o.record, "utf8").split("\\n").some((l) => {
    let m;
    try { m = JSON.parse(l); } catch { return false; }
    return m.dir === "out" && m.verb === "f" && m.body.sf === "s:1" && m.body.s === o.submitted;
  });
  if (done) delete o.submitted;
  return done;
}
switch (a[0]) {
  case "--version": out("tern 0.9.2\\n");
  case "inspect": {
    const panes = Object.entries(w.panes).flatMap(([id, p]) => {
      // omp moves on from a prompt only once it has taken it.
      if (ompFg(p) && p.states && p.states.length && landed(p.omp)) { const next = p.states.shift(); if (next !== null) become(p, next); }
      if (p.exitAfterInspects > 0 && --p.exitAfterInspects === 0) p.foreground = p.child;
      if (p.missingOnInspect > 0 && --p.missingOnInspect === 0) return [];
      return [{ pane: Number(id), title: p.title, cwd: p.cwd, working: !!p.working, omp_session_file: p.session || null, quiet_ms: 5000 }];
    });
    const blocks = Object.entries(w.panes).map(([id, p]) => ({ id: Number(id), tab: p.tab }));
    const tabs = [...new Set(blocks.map((b) => b.tab))].map((tab) => ({ id: tab, blocks: blocks.filter((b) => b.tab === tab).map((b) => ({ id: b.id })) }));
    out({ sessions: [{ id: 4, name: "Default", tabs }], detached: [], panes, clients: [] });
  }
  case "process": {
    const p = pane(a[1]);
    if (p.processFails > 0) { p.processFails -= 1; fail("the session daemon did not answer"); }
    out({ pane: Number(a[1]), child: p.child, foreground: p.foreground });
  }
  case "split": {
    const target = pane(a[1]);
    const id = String(w.next++);
    const cwd = a.includes("--cwd") ? a[a.indexOf("--cwd") + 1] : target.cwd;
    const pid = w.next++;
    w.panes[id] = { tab: target.tab, title: "zsh", cwd, child: shell(pid), foreground: shell(pid) };
    out({ session: 4, tab: target.tab, block: Number(id) });
  }
  case "run": {
    const p = pane(a[1]);
    // A shell runs whatever already sits on its input line ahead of the command.
    p.executed = [...(p.executed || []), (p.lineBuffer || "") + a[2]];
    p.lineBuffer = "";
    if (/\\bomp\\b/.test(a[2]) && w.launch) {
      const m = /PI_TUI_TSP_RECORD=(?:'([^']*)'|(\\S+))/.exec(a[2]);
      const o = p.omp = { record: w.launch.noRecord || !m ? null : m[1] ?? m[2], s: 0, text: "", sendable: false, state: "starting", working: false, unacked: !!w.launch.unacked };
      p.foreground = { pid: w.launch.pid, name: "omp", argv: ["omp"], cwd: p.cwd };
      p.session = w.launch.session;
      write(o, { dir: "out", verb: "o", body: { id: "s:1", mode: "inline", title: "omp", role: "omp.session" } });
      frame(o, [["add", "main", "s:1", null, { id: "main", k: "col" }], ["add", "dock", "s:1", null, { id: "dock", k: "col", c: [{ id: "b", k: "col" }, { id: "e", k: "col", c: [composer(o)] }] }], ["add", "layer", "s:1", null, { id: "layer", k: "col" }]]);
      p.states = [...(w.launch.states || ["idle"])];
      if (w.launch.failureAfterRun) w.failure = w.launch.failureAfterRun;
    }
    out("");
  }
  case "send": {
    const p = pane(a[1]);
    const o = p.omp;
    if (a[2] === "paste" && !ompFg(p)) p.lineBuffer = (p.lineBuffer || "") + a[3];
    if (a[2] === "paste" && ompFg(p)) {
      if (p.failureAfterPaste) w.failure = p.failureAfterPaste;
      if (p.statesAfterPaste) { p.states = [...p.statesAfterPaste]; delete p.statesAfterPaste; }
      if (o.state !== "blocked" && !p.pasteLost) {
        o.text += a[3];
        frame(o, [["text", "j.line/input", "append", a[3]]], p.echoDelayMs || 0);
        p.echoAt = Date.now() + (p.echoDelayMs || 0);
      }
    }
    if (a[2] === "keys") for (const key of a.slice(3)) {
      if (!ompFg(p)) {
        // zsh's ctrl+u (kill-whole-line) removes one line of a multi-line input per press.
        if (key === "ctrl+u") p.lineBuffer = (p.lineBuffer || "").slice(0, Math.max(0, (p.lineBuffer || "").lastIndexOf("\\n")));
        // An interrupt while zsh still sources its rc file cuts the rest of it.
        if (key === "ctrl+c") { p.lineBuffer = ""; if (p.rcLoading) p.rcAborted = true; }
      } else if (key === "ctrl+u" && o.state !== "blocked") {
        const cut = Math.max(0, o.text.lastIndexOf("\\n"));
        frame(o, [["splice", "j.line/input", cut, o.text.length - cut, ""]]);
        o.text = o.text.slice(0, cut);
      } else if (key === "Down" && o.state === "blocked") {
        frame(o, [["set", "u.q0", { selected: "u.q0/option:1" }]]);
      } else if (key === "Enter") {
        if (p.failureAfterEnter) w.failure = p.failureAfterEnter;
        if (p.echoAt > Date.now()) p.enterBeforeEcho = true;
        if (p.exitOnEnter) { delete p.exitOnEnter; become(p, "exit"); continue; }
        if (o.state === "blocked") { p.states = [...(p.afterEnter || ["idle"])]; delete p.afterEnter; continue; }
        if (!o.text || p.enterLost) continue;
        submit(p, p.submitDelayMs || 0);
      }
    }
    out("");
  }
  case "capture": { const p = pane(a[1]); out(a.includes("--scrollback") ? p.scrollback : p.screen); }
  case "rename": case "focus": out("");
  case "close": pane(a[1]); delete w.panes[a[1]]; out("");
  default: fail("unknown command");
}
`;

const shell = (pid) => ({ pid, name: "zsh", argv: ["/bin/zsh"], cwd: "/repo" });
const omp = (pid) => ({ pid, name: "omp", argv: ["omp", "--model", "m"], cwd: "/repo" });

// The orchestrator's own pane: omp that agent start did not launch, so Tern's
// working flag is all the shim reads of it.
const orchestrator = () => ({ tab: 6, title: "TERN: orchestrate", cwd: "/repo", working: true, session: "/s/orch.jsonl", child: shell(1), foreground: omp(2) });

// One line of omp's surface record, written at `t`.
const recordLine = (t, dir, verb, body) => `${JSON.stringify({ t, dir, verb, params: null, body })}\n`;
// omp's ask dialog, in the composer's place.
const DIALOG = [["add", "u", "e", null, { id: "u", k: "col", p: { role: "omp.editor.ask" } }], ["del", "j"]];

function world(t, panes, extra = {}) {
  const { env: testEnv = {}, fakeTime = false, ...state } = extra;
  const dir = mkdtempSync(join(tmpdir(), "tern-herdr-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "tern"), FAKE_TERN);
  chmodSync(join(dir, "tern"), 0o755);
  const file = join(dir, "world.json");
  const stateDir = join(dir, "state");
  const clockFile = join(dir, "clock.json");
  const clockModule = join(dir, "clock.cjs");
  if (fakeTime) writeFileSync(clockModule, `
    let now = 0;
    const sleeps = [];
    Date.now = () => now;
    Atomics.wait = (_array, _index, _value, ms) => {
      now += ms;
      sleeps.push(ms);
      require("node:fs").writeFileSync(${JSON.stringify(clockFile)}, JSON.stringify(sleeps));
      return "timed-out";
    };
  `);
  writeFileSync(file, JSON.stringify({ panes, next: 100, calls: [], ...state }));
  const env = { PATH: `${dir}:${process.env.PATH}`, FAKE_TERN_WORLD: file, SUPERMATT_TERN_HERDR_DIR: stateDir, TERN_PANE: "13", ...testEnv };
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  return {
    stateDir,
    run(...args) {
      const r = spawnSync(process.execPath, [...(fakeTime ? ["--require", clockModule] : []), cli, ...args], { env, encoding: "utf8", timeout: 20_000 });
      let json;
      try { json = JSON.parse(r.stdout); } catch {}
      let error;
      try { error = JSON.parse(r.stderr).error; } catch {}
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, json, error };
    },
    read,
    calls: () => read().calls,
    sleeps: () => JSON.parse(readFileSync(clockFile, "utf8")),
    edit(fn) { const w = read(); fn(w); writeFileSync(file, JSON.stringify(w)); },
    // Appends a frame of `ops` for surface `sf` to the record of the omp in
    // `pane`, acknowledged unless `acked` is false, `t` ms after now.
    frame(pane, ops, { acked = true, t = 0, sf = "s:1" } = {}) {
      const w = read();
      const o = w.panes[pane].omp;
      o.s += 1;
      const at = Date.now() + t;
      appendFileSync(o.record, recordLine(at, "out", "f", { sf, s: o.s, ops }));
      if (acked) appendFileSync(o.record, recordLine(at, "in", "e", { ev: "ack", sf, s: o.s }));
      writeFileSync(file, JSON.stringify(w));
    },
    // Appends a message other than a frame, such as a surface's open or close.
    message(pane, verb, body) {
      appendFileSync(read().panes[pane].omp.record, recordLine(Date.now(), "out", verb, body));
    },
    record: (pane) => read().panes[pane].omp.record,
  };
}

// A lane pane at its shell prompt, and the omp launch the fake answers `tern run` with.
const ready = { pid: 4242, session: "/s/worker.jsonl" };
function lane(t, extra = {}) {
  return world(t, { 13: orchestrator(), 50: { tab: 6, title: "zsh", cwd: "/repo/wt", child: shell(60), foreground: shell(60) } }, { launch: ready, ...extra });
}

// A started worker in pane 50, ready for a prompt. The call log then starts
// empty, so a test sees only the tern calls its own commands made.
function worker(t, extra = {}) {
  const w = lane(t, extra);
  const r = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50");
  assert.equal(r.code, 0, r.stderr);
  w.edit((x) => { x.calls = []; });
  return w;
}
const sends = (w) => w.calls().filter((c) => c[0] === "send");

test("pane split opens a shell block beside the target and returns its id", (t) => {
  const w = world(t, { 13: orchestrator() });
  const r = w.run("pane", "split", "13", "--direction", "right", "--no-focus", "--cwd", "/repo");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.pane.pane_id, "100");
  assert.deepEqual(w.calls().find((c) => c[0] === "split"), ["split", "13", "right", "--cwd", "/repo", "--json"]);
  assert.ok(!w.calls().some((c) => c[0] === "focus"), "--no-focus keeps the caller focused");
});

test("agent start launches native omp recording its surface, and the name then resolves to it", (t) => {
  const w = lane(t);
  const r = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50", "--", "--model", "omniroute/opus-5.5", "--config", "/a dir/omp-worker.yml");
  assert.equal(r.code, 0, r.stderr);
  const run = w.calls().find((c) => c[0] === "run");
  const record = w.record(50);
  assert.ok(record.startsWith(join(w.stateDir, "records") + "/"), record);
  assert.deepEqual(run, ["run", "50", `PI_TUI_NATIVE=1 PI_TUI_TSP_RECORD=${record} omp --model omniroute/opus-5.5 --config '/a dir/omp-worker.yml'`]);
  const got = w.run("agent", "get", "app-work-1-1");
  assert.equal(got.code, 0, got.stderr);
  assert.equal(got.json.result.agent.pane_id, "50");
  assert.equal(got.json.result.agent.agent, "omp");
  assert.equal(got.json.result.agent.name, "app-work-1-1");
  assert.equal(got.json.result.agent.agent_status, "idle");
  assert.deepEqual(got.json.result.agent.agent_session, { agent: "omp", kind: "path", source: "tern", value: "/s/worker.jsonl" });
});

test("agent start returns only once the composer can take a prompt", (t) => {
  const w = lane(t, { launch: { ...ready, states: [null, null, "idle"] } });
  assert.equal(w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50").code, 0);
  assert.deepEqual(w.read().panes[50].states, [], "start polled until the composer was sendable");
});

test("agent start refuses a pane whose shell is not in the foreground", (t) => {
  const w = lane(t);
  w.edit((x) => { x.panes[50].foreground = omp(61); });
  const r = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50");
  assert.equal(r.code, 1);
  assert.equal(r.error.code, "agent_pane_busy");
  assert.ok(!w.calls().some((c) => c[0] === "run" || c[0] === "send"), "nothing is typed into a busy pane");
});

test("agent start refuses a name a live agent holds, and kinds other than omp", (t) => {
  const w = world(t, {
    13: orchestrator(),
    50: { tab: 6, title: "zsh", cwd: "/r", child: shell(60), foreground: shell(60) },
    51: { tab: 6, title: "zsh", cwd: "/r", child: shell(62), foreground: shell(62) },
  }, { launch: ready });
  assert.equal(w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50").code, 0);
  const taken = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "51");
  assert.equal(taken.error.code, "agent_name_in_use");
  const claude = w.run("agent", "start", "app-work-1-2", "--kind", "claude", "--pane", "51");
  assert.equal(claude.code, 1);
  assert.equal(claude.error.code, "unsupported_agent_kind");
});

test("agent start reports agent_not_ready when omp opens on a dialog, and keeps the name", (t) => {
  const w = lane(t, { launch: { ...ready, states: ["blocked"] } });
  const r = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50");
  assert.equal(r.error.code, "agent_not_ready");
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "blocked");
});

test("agent start times out when omp never comes up, or never records its surface", (t) => {
  const w = lane(t, { launch: null });
  const r = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50", "--timeout", "600");
  assert.equal(r.code, 1);
  assert.equal(r.error.code, "timeout");
  const silent = lane(t, { launch: { ...ready, noRecord: true } });
  const s = silent.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50", "--timeout", "600");
  assert.equal(s.error?.code, "timeout");
  assert.match(s.error.message, /surface record/);
});

test("a name is cleared once its omp exits, and its surface record goes with it", (t) => {
  const w = lane(t);
  w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50");
  const record = w.record(50);
  w.edit((x) => { x.panes[50].foreground = shell(60); });
  assert.equal(w.run("agent", "get", "app-work-1-1").error.code, "agent_not_found");
  assert.ok(!existsSync(record), "the record of the exited worker was removed");
});

test("a name does not follow a later omp in the same pane", (t) => {
  const w = lane(t);
  w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50");
  w.edit((x) => { x.panes[50].foreground = omp(9999); });
  assert.equal(w.run("agent", "get", "app-work-1-1").error.code, "agent_not_found");
});

test("agent rename refuses a name another live agent holds", (t) => {
  const w = lane(t);
  w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50");
  const r = w.run("agent", "rename", "13", "app-work-1-1");
  assert.equal(r.error.code, "agent_name_in_use");
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.pane_id, "50");
});

test("a renamed worker keeps reading its own surface record", (t) => {
  const w = worker(t);
  assert.equal(w.run("agent", "rename", "app-work-1-1", "app-work-1-2").code, 0);
  w.frame(50, DIALOG);
  assert.equal(w.run("agent", "get", "app-work-1-2").json.result.agent.agent_status, "blocked");
  assert.equal(w.run("agent", "get", "app-work-1-1").error?.code, "agent_not_found");
});

test("the orchestrator renames its own pane, and list shows the name with Tern's working state", (t) => {
  const w = world(t, { 13: orchestrator(), 50: { tab: 6, title: "zsh", cwd: "/r", child: shell(60), foreground: shell(60) } });
  const r = w.run("agent", "rename", "13", "app-orch-1");
  assert.equal(r.code, 0, r.stderr);
  const list = w.run("agent", "list");
  assert.deepEqual(list.json.result.agents.map((a) => [a.name, a.pane_id, a.agent_status]), [["app-orch-1", "13", "working"]]);
  assert.equal(w.run("agent", "get", "app-orch-1").json.result.agent.agent_session.value, "/s/orch.jsonl");
});

test("an omp Tern resumes from its versioned binary is the orchestrator's agent", (t) => {
  const resumed = { pid: 2, name: "18.12.1", argv: ["/Users/u/Library/Application Support/Tern/omp/versions/18.12.1", "--resume", "/s/orch.jsonl"], cwd: "/repo" };
  const w = world(t, { 13: { ...orchestrator(), foreground: resumed } });
  const r = w.run("agent", "get", "13");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agent.agent, "omp");
  assert.equal(r.json.result.agent.agent_session.value, "/s/orch.jsonl");
});

test("agent get on an unknown target fails with Herdr's error shape", (t) => {
  const w = world(t, { 13: orchestrator() });
  const r = w.run("agent", "get", "nobody");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "agent_not_found", message: "agent target nobody not found" });
});

test("report-metadata's display label shows on the agent", (t) => {
  const w = lane(t);
  w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50");
  assert.equal(w.run("pane", "report-metadata", "50", "--source", "orchestrate", "--display-agent", "worker 1").code, 0);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.display_agent, "worker 1");
});

test("pane run, pane close and tab rename go to the matching tern commands", (t) => {
  const w = lane(t);
  assert.equal(w.run("pane", "run", "50", "cd '/repo/wt'").code, 0);
  assert.equal(w.run("tab", "rename", "13", "#4 implement | #5 qa").code, 0);
  assert.equal(w.run("pane", "close", "50").code, 0);
  const calls = w.calls();
  assert.deepEqual(calls.find((c) => c[0] === "run"), ["run", "50", "cd '/repo/wt'"]);
  assert.deepEqual(calls.find((c) => c[0] === "rename"), ["rename", "13", "#4 implement | #5 qa"]);
  assert.deepEqual(calls.find((c) => c[0] === "close"), ["close", "50"]);
});

test("a command or flag outside the supported subset fails as a syntax error", (t) => {
  const w = lane(t);
  w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50");
  const outside = [
    ["workspace", "list"],
    ["pane", "split", "13", "--direction", "right", "--env", "A=1"],
    ["pane", "split", "13", "--direction", "right", "--focus"],
    ["pane", "split", "--current", "--direction", "right"],
    ["integration", "status", "--bogus"],
    ["agent", "start", "--help", "--bogus"],
    ["agent", "list", "extra"],
    ["agent", "rename", "app-work-1-1", "--clear"],
    ["agent", "read", "app-work-1-1", "--format", "bogus"],
    ["agent", "read", "app-work-1-1", "--format", "ansi"],
    ["agent", "read", "app-work-1-1", "--source", "detection"],
    ["agent", "read", "app-work-1-1", "--ansi"],
    ["pane", "report-metadata", "50", "--source", "orchestrate", "--clear-display-agent"],
  ];
  assert.deepEqual(outside.filter((args) => w.run(...args).code !== 2), []);
  assert.equal(w.calls().filter((c) => c[0] === "split").length, 0);
});

test("a prompt or a start rejected for a bad argument types and launches nothing", (t) => {
  const w = worker(t);
  assert.equal(w.run("agent", "prompt", "app-work-1-1", "go", "--wait", "--until", "bogus").code, 2);
  assert.deepEqual(sends(w), [], "the prompt was not typed");
  w.edit((x) => { x.panes[51] = { tab: 6, title: "zsh", cwd: "/r", child: shell(62), foreground: shell(62) }; });
  assert.equal(w.run("agent", "start", "app-work-1-2", "--kind", "omp", "--pane", "51", "--timeout", "-1").code, 2);
  assert.deepEqual(w.calls().filter((c) => c[0] === "run" || c[0] === "send"), [], "nothing was typed into pane 51");
});

test("the tab_id pane split returns is a target tab rename accepts", (t) => {
  const w = world(t, { 13: orchestrator() });
  const tab = w.run("pane", "split", "13", "--direction", "right", "--no-focus").json.result.pane.tab_id;
  assert.equal(w.run("tab", "rename", tab, "#4 implement").code, 0);
  const rename = w.calls().find((c) => c[0] === "rename");
  assert.ok(["13", "100"].includes(rename[1]), `renamed through a block of tab ${tab}: ${rename}`);
  assert.equal(rename[2], "#4 implement");
});

test("agent prompt --wait pastes the text, presses Enter, and returns once the turn settles", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].afterEnter = ["working", "working", "idle"]; });
  const r = w.run("agent", "prompt", "app-work-1-1", "/skill:implement #4", "--wait");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agent.agent_status, "done");
  assert.deepEqual(sends(w), [["send", "50", "paste", "/skill:implement #4"], ["send", "50", "keys", "Enter"]]);
  assert.equal(w.read().panes[50].prompts, 1);
});

test("agent prompt --wait settles on a dialog as blocked", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].afterEnter = ["working", "blocked"]; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go", "--wait");
  assert.equal(r.json?.result.agent.agent_status, "blocked", r.stderr);
});

test("agent prompt --wait reads a turn that ended before its first read as done", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].afterEnter = ["idle"]; });
  assert.equal(w.run("agent", "prompt", "app-work-1-1", "go", "--wait").json?.result.agent.agent_status, "done");
});

test("agent prompt refuses a blocked agent before typing anything", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].states = ["blocked"]; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go", "--wait");
  assert.equal(r.error?.code, "agent_blocked");
  assert.match(r.error.message, /nothing was typed/);
  assert.deepEqual(sends(w), []);
});

test("agent prompt refuses a composer that already holds text, before typing anything", (t) => {
  const w = worker(t);
  w.frame(50, [["text", "j.line/input", "append", "half a thought"]]);
  const r = w.run("agent", "prompt", "app-work-1-1", "go");
  assert.equal(r.error?.code, "agent_not_ready");
  assert.match(r.error.message, /nothing was typed/);
  assert.deepEqual(sends(w), []);
});

test("agent prompt waits for a slow paste to show before pressing Enter", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].echoDelayMs = 400; });
  const r = w.run("agent", "prompt", "app-work-1-1", "/exit", "--wait");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!w.read().panes[50].enterBeforeEcho, "the Enter waited for the paste to show");
  assert.equal(w.read().panes[50].prompts, 1);
});

test("agent prompt presses no Enter when the paste never shows", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].pasteLost = true; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go");
  assert.equal(r.error?.code, "agent_prompt_stalled");
  assert.ok(!sends(w).some((c) => c[2] === "keys"), "no Enter was sent");
});

test("agent prompt reports agent_prompt_stalled when omp keeps the prompt after Enter", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].enterLost = true; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go", "--wait");
  assert.equal(r.error?.code, "agent_prompt_stalled");
  assert.match(r.error.message, /sits unsent/);
});

test("agent prompt stops before Enter when a dialog opens between the paste and the Enter", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].statesAfterPaste = ["blocked"]; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go", "--wait");
  assert.equal(r.error?.code, "agent_blocked");
  assert.ok(!sends(w).some((c) => c[2] === "keys"), "no Enter reached the dialog");
});

test("a dialog that opens after the paste showed says the text sits unsent", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].statesAfterPaste = [null, "blocked"]; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go");
  assert.equal(r.error?.code, "agent_blocked");
  assert.match(r.error.message, /sits unsent/);
  assert.ok(!sends(w).some((c) => c[2] === "keys"), "no Enter reached the dialog");
});

test("agent prompt presses no Enter when omp exits between the paste and the Enter", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].statesAfterPaste = ["exit"]; });
  assert.equal(w.run("agent", "prompt", "app-work-1-1", "go").error?.code, "agent_not_found");
  assert.ok(!sends(w).some((c) => c[2] === "keys"), "no Enter reached the shell");
});

test("agent prompt types nothing into a pane omp has left", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].foreground = shell(60); });
  assert.equal(w.run("agent", "prompt", "app-work-1-1", "rm -rf build").error?.code, "agent_not_found");
  assert.deepEqual(sends(w), [], "nothing reached the shell left in the pane");
});

test("agent prompt /exit returns once omp has left", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].exitOnEnter = true; });
  const r = w.run("agent", "prompt", "app-work-1-1", "/exit");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.run("agent", "get", "app-work-1-1").error?.code, "agent_not_found");
});

test("agent prompt refuses an omp that agent start did not launch, before typing", (t) => {
  const w = world(t, { 13: orchestrator() });
  const r = w.run("agent", "prompt", "13", "go");
  assert.equal(r.error?.code, "agent_state_hidden");
  assert.match(r.error.message, /nothing was typed/);
  assert.deepEqual(sends(w), []);
});

test("agent prompt --timeout cuts a long turn off with timeout", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].afterEnter = Array(200).fill("working"); });
  const r = w.run("agent", "prompt", "app-work-1-1", "go", "--wait", "--timeout", "800");
  assert.equal(r.error?.code, "timeout");
});

test("agent prompt without --wait returns once omp took the prompt, without waiting for the turn", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].afterEnter = Array(200).fill("working"); });
  const r = w.run("agent", "prompt", "app-work-1-1", "go");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agent.agent_status, "idle", "the state before the prompt");
  assert.ok(w.read().panes[50].states.length > 190, "the turn was not waited for");
});

test("agent wait returns at the first matching state, and --until narrows it", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].states = ["working", "blocked", "idle"]; });
  assert.equal(w.run("agent", "wait", "app-work-1-1", "--until", "idle", "--until", "done", "--until", "blocked").json.result.agent.agent_status, "blocked");
  w.edit((x) => { x.panes[50].states = ["working", "working", "idle"]; });
  assert.equal(w.run("agent", "wait", "app-work-1-1", "--until", "done").json.result.agent.agent_status, "done");
  const r = w.run("agent", "wait", "app-work-1-1", "--until", "working", "--timeout", "500");
  assert.equal(r.error.code, "timeout");
});

test("agent wait reads an idle worker it never saw work as idle", (t) => {
  const w = worker(t);
  assert.equal(w.run("agent", "wait", "app-work-1-1").json?.result.agent.agent_status, "idle");
});

test("agent wait fails with agent_not_found when the worker exits while it waits", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].states = ["working", "exit"]; });
  assert.equal(w.run("agent", "wait", "app-work-1-1").error?.code, "agent_not_found");
});

test("a worker that closed its surface reads as gone to a wait, though its process lingers", (t) => {
  const w = worker(t);
  w.message(50, "x", { id: "s:1", keep: true });
  assert.equal(w.run("agent", "wait", "app-work-1-1", "--timeout", "2000").error?.code, "agent_not_found");
  assert.equal(w.run("agent", "prompt", "app-work-1-1", "go").error?.code, "agent_not_found");
  assert.deepEqual(sends(w), []);
});

test("a worker that suspends its surface shows no state: get reads unknown, a wait fails at once", (t) => {
  const w = worker(t);
  w.frame(50, [["suspend"]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "unknown");
  const r = w.run("agent", "wait", "app-work-1-1", "--timeout", "5000");
  assert.equal(r.error?.code, "agent_state_hidden");
  assert.match(r.error.message, /handed its pane back/);
  const p = w.run("agent", "prompt", "app-work-1-1", "go");
  assert.equal(p.error?.code, "agent_state_hidden");
  assert.match(p.error.message, /nothing was typed/);
  assert.deepEqual(sends(w), []);
  w.frame(50, [["resume"]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "idle");
});

test("a worker whose surface record is gone shows no state", (t) => {
  const w = worker(t);
  rmSync(w.record(50));
  rmSync(join(w.stateDir, "replays"), { recursive: true, force: true });
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "unknown");
  assert.match(w.run("agent", "wait", "app-work-1-1").error?.message, /no surface record/);
});

test("agent read prints Tern's capture of the chat, then the dock as text", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].screen = "s1\ns2\ns3\n"; x.panes[50].scrollback = "h1\nh2\ns1\ns2\ns3\n"; });
  w.frame(50, [["text", "j.line/input", "append", "draft one\ndraft two"]]);
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "visible", "--lines", "3").stdout, "s3\n> draft one\n> draft two\n");
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "recent-unwrapped", "--lines", "6").stdout, "h2\ns1\ns2\ns3\n> draft one\n> draft two\n");
  const captures = w.calls().filter((c) => c[0] === "capture");
  assert.deepEqual(captures, [["capture", "50", "--surfaces"], ["capture", "50", "--surfaces", "--scrollback"]]);
});

test("agent read shows a dialog with its highlighted option, check marks, tabs, answers and key hints", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].screen = "chat\n"; });
  w.frame(50, [
    ["add", "q", "b", null, { id: "q", k: "row", p: { role: "omp.working" }, c: [{ id: "q.s", k: "spinner" }, { id: "q.l", k: "shimmer", p: { spans: [{ t: "Asking" }] } }, { id: "q.stop", k: "row", p: { title: "Stop  esc", actions: { click: "stop" } } }] }],
    ["add", "u", "e", null, { id: "u", k: "col", p: { role: "omp.editor.ask" }, c: [
      { id: "u.tabs", k: "tabs", p: { items: [{ id: "0", label: [{ t: "✓ " }, { t: "fruits" }] }, { id: "1", label: [{ t: "size" }] }], active: "1", title: "Next question  tab" } },
      { id: "u.q", k: "md", p: { text: "Which fruits?" } },
      { id: "u.l", k: "list", p: { selected: "u.l/1" }, c: [
        { id: "u.l/0", k: "item", p: { label: [{ t: "apple" }], role: "omp.ask.check", icon: "check" } },
        { id: "u.l/1", k: "item", p: { label: [{ t: "pear" }], role: "omp.ask.check" } },
        { id: "u.l/2", k: "item", p: { label: [{ t: "Other…" }], detail: [{ t: "Type your own answer" }], role: "omp.ask.other" } },
        { id: "u.l/3", k: "item", p: { label: [{ t: "gone" }], hidden: true } }] },
      { id: "u.kv", k: "kv", p: { items: [{ k: "fruits", v: [{ t: "apple" }] }] } },
      { id: "u.keys", k: "row", c: [{ id: "u.keys/0", k: "text", p: { text: "Hide" } }, { id: "u.keys/1", k: "kbd", p: { keys: ["alt", "h"] } }] },
      { id: "u.submit", k: "row", p: { title: "Next  enter · Toggle  space", actions: { click: "submit" } }, c: [{ id: "u.submit/0", k: "text", p: { text: "Next" } }] }] }],
    ["del", "j"],
  ]);
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, [
    "chat",
    "Asking  [Stop  esc]",
    " ✓ fruits  ›size   (Next question  tab)",
    "Which fruits?",
    "  [x] apple",
    "› [ ] pear",
    "  Other…  Type your own answer",
    "fruits: apple",
    "Hide  [alt+h]",
    "[Next  enter · Toggle  space]",
    "",
  ].join("\n"));
});

test("the dock follows moves, splices, hidden nodes and props set to null", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].screen = ""; });
  w.frame(50, [
    ["add", "n", "b", null, { id: "n", k: "text", p: { text: "note", title: "x" } }],
    ["add", "m", "layer", null, { id: "m", k: "col", c: [{ id: "m.t", k: "text", p: { text: "moved" } }] }],
    ["text", "j.line/input", "replace", "abcdef"],
  ]);
  w.frame(50, [["splice", "j.line/input", 1, 3, "X"], ["move", "m", "b", "n"], ["set", "n", { text: null, spans: [{ t: "spanned" }] }], ["settle", "n"]]);
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, "moved\nspanned\n> aXef\n");
  w.frame(50, [["move", "n", "nowhere", null]]);
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, "moved\n> aXef\n", "a node moved out of the dock is gone");
  w.frame(50, [["set", "b", { hidden: true }]]);
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, "> aXef\n");
});

test("a working row reads as working until it goes", (t) => {
  const w = worker(t);
  w.frame(50, [["add", "q", "b", null, { id: "q", k: "row", p: { role: "omp.working" } }]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "working");
  w.frame(50, [["del", "q"]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "idle");
});

test("a working row omp keeps hidden does not read as working", (t) => {
  const w = worker(t);
  w.frame(50, [["add", "q", "b", null, { id: "q", k: "row", p: { role: "omp.working", hidden: true } }]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "idle");
  w.frame(50, [["set", "q", { hidden: null }]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "working");
});

test("a dialog omp has hidden until the answer is ready still reads as blocked", (t) => {
  const w = worker(t);
  w.frame(50, [["add", "u", "e", null, { id: "u", k: "col", p: { role: "omp.editor.ask.hidden" } }], ["del", "j"]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "blocked");
});

// Appends, `after` ms from now, the frame omp sends at `at` ms from now.
function flushLater(w, after, at, ops, sf = "s:1") {
  const line = recordLine(Date.now() + at, "out", "f", { sf, s: 99, ops });
  spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").appendFileSync(${JSON.stringify(w.record(50))}, ${JSON.stringify(line)}), ${after})`], { detached: true, stdio: "ignore" }).unref();
}
const timed = (fn) => { const started = Date.now(); const value = fn(); return [value, Date.now() - started]; };

// omp sends no more than two frames Tern has not acknowledged; a pane out of
// sight acknowledges none, and omp sends what it held five seconds after the
// oldest unacknowledged frame, counting every earlier frame as acknowledged.
test("a read waits for the frames omp holds back while its pane is out of sight", (t) => {
  const w = worker(t);
  w.frame(50, [["add", "q", "b", null, { id: "q", k: "row", p: { role: "omp.working" } }]], { acked: false, t: -2500 });
  w.frame(50, [], { acked: false, t: -2400 });
  flushLater(w, 600, 2500, DIALOG);
  const [r, took] = timed(() => w.run("agent", "get", "app-work-1-1"));
  assert.equal(r.json.result.agent.agent_status, "blocked");
  assert.ok(took >= 500, "the read waited for the held frames");
});

// While omp keeps drawing in a pane out of sight, it sends two frames, holds
// the rest for five seconds, sends them, and holds again: here, pairs stamped
// five seconds apart, all in the record before the read starts.
test("a read of a worker that keeps drawing out of sight returns within one hold", (t) => {
  const w = worker(t);
  w.frame(50, [["add", "q", "b", null, { id: "q", k: "row", p: { role: "omp.working" } }]], { acked: false, t: -3000 });
  w.frame(50, [], { acked: false, t: -2900 });
  for (const at of [2100, 2100, 7200, 7200]) w.frame(50, [], { acked: false, t: at });
  const [r, took] = timed(() => w.run("agent", "get", "app-work-1-1"));
  assert.equal(r.json?.result.agent.agent_status, "working", r.stderr);
  assert.ok(took < 8000, `the read waited out one hold, not every later one (${took}ms)`);
});

test("a frame omp sends after its timeout starts a new count of held frames", (t) => {
  const w = worker(t);
  w.frame(50, [], { acked: false, t: -9000 });
  w.frame(50, [["add", "q", "b", null, { id: "q", k: "row", p: { role: "omp.working" } }]], { acked: false, t: -2500 });
  w.frame(50, [], { acked: false, t: -2400 });
  flushLater(w, 600, 2500, DIALOG);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "blocked");
});

test("frames older than omp's acknowledgement timeout count as sent", (t) => {
  const w = worker(t);
  w.frame(50, [["add", "q", "b", null, { id: "q", k: "row", p: { role: "omp.working" } }]], { acked: false, t: -9000 });
  w.frame(50, [], { acked: false, t: -8000 });
  const [r, took] = timed(() => w.run("agent", "get", "app-work-1-1"));
  assert.equal(r.json.result.agent.agent_status, "working");
  assert.ok(took < 3000, "no wait for frames omp already sent");
});

test("frames Tern acknowledged are not waited for, on the session or a full-screen surface", (t) => {
  const w = worker(t);
  w.frame(50, [["add", "q", "b", null, { id: "q", k: "row", p: { role: "omp.working" } }]]);
  w.frame(50, []);
  const [r, took] = timed(() => w.run("agent", "get", "app-work-1-1"));
  assert.equal(r.json.result.agent.agent_status, "working");
  assert.ok(took < 3000, "no wait for acknowledged session frames");
  w.message(50, "o", { id: "s:2", mode: "screen", role: "omp.session" });
  w.frame(50, [], { sf: "s:2" });
  w.frame(50, [], { sf: "s:2" });
  const [s, screenTook] = timed(() => w.run("agent", "get", "app-work-1-1"));
  assert.equal(s.json.result.agent.agent_status, "blocked");
  assert.ok(screenTook < 3000, "no wait for acknowledged full-screen frames");
});

test("agent send-keys maps Herdr key names onto Tern's, and checks every key before sending", (t) => {
  const w = worker(t);
  assert.equal(w.run("agent", "send-keys", "app-work-1-1", "down", "esc", "ctrl+c", "shift+tab", "enter", "y").code, 0);
  assert.deepEqual(sends(w).at(-1), ["send", "50", "keys", "Down", "Escape", "ctrl+c", "shift+Tab", "Enter", "y"]);
  const bad = w.run("agent", "send-keys", "app-work-1-1", "down", "hyper+q");
  assert.equal(bad.error.code, "invalid_key");
  assert.equal(sends(w).length, 1);
});

test("send-keys that answers a dialog returns once it closes, so the next wait does not see a stale blocked", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].states = ["blocked"]; x.panes[50].afterEnter = ["blocked", "working", "idle"]; });
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "blocked");
  assert.equal(w.run("agent", "send-keys", "app-work-1-1", "down").code, 0);
  assert.match(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, /› Blue/);
  assert.equal(w.run("agent", "send-keys", "app-work-1-1", "enter").code, 0);
  assert.equal(w.run("agent", "wait", "app-work-1-1").json.result.agent.agent_status, "idle");
});

test("send-keys succeeds when the dialog it answers ends omp", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].states = ["blocked"]; x.panes[50].exitOnEnter = true; });
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "blocked");
  const r = w.run("agent", "send-keys", "app-work-1-1", "enter");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.run("agent", "get", "app-work-1-1").error?.code, "agent_not_found");
});

test("send-keys succeeds when the dialog it answers leaves the surface suspended", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].states = ["blocked"]; x.panes[50].afterEnter = ["suspend"]; });
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "blocked");
  const r = w.run("agent", "send-keys", "app-work-1-1", "enter");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.result.keys, ["Enter"]);
});

// TERN.md's Setup gates the run on these two answers.
test("integration status and agent start --help name omp as served", (t) => {
  const w = world(t, { 13: orchestrator() });
  assert.match(w.run("integration", "status").stdout, /^omp: current \(tern 0\.9\.2/);
  assert.match(w.run("agent", "start", "--help").stdout, /kinds: omp\b/);
});

test("a failing tern command surfaces as tern_failed with tern's own message", (t) => {
  const w = world(t, { 13: orchestrator() });
  const r = w.run("pane", "run", "999", "ls");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern run: no block 999" });
});

test("a read recovers after two os error 35 failures", (t) => {
  const w = world(t, { 13: orchestrator() }, {
    failure: { command: "inspect", remaining: 2, message: "os error 35" },
  });
  const r = w.run("agent", "list");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agents[0].pane_id, "13");
  assert.equal(w.calls().filter((c) => c[0] === "inspect").length, 3);
});

test("a read recovers after Resource temporarily unavailable failures", (t) => {
  const w = world(t, { 13: orchestrator() }, {
    failure: { command: "inspect", remaining: 2, message: "Resource temporarily unavailable" },
  });
  const r = w.run("agent", "list");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agents[0].pane_id, "13");
  assert.equal(w.calls().filter((c) => c[0] === "inspect").length, 3);
});

test("persistent EAGAIN fails after the sixty-second retry budget", (t) => {
  const w = world(t, { 13: orchestrator() }, {
    fakeTime: true,
    failure: { command: "inspect", remaining: 1000, message: "os error 35" },
  });
  const r = w.run("agent", "list");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern inspect: os error 35" });
  const sleeps = w.sleeps();
  assert.deepEqual(sleeps.slice(0, 4), [100, 200, 400, 800]);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 1000));
  assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), 60_000);
  assert.equal(w.calls().length, sleeps.length + 1);
});

test("a non-EAGAIN read failure is reported without retrying", (t) => {
  const w = world(t, { 13: orchestrator() }, {
    fakeTime: true,
    failure: { command: "inspect", remaining: 2, message: "permission denied" },
  });
  const r = w.run("agent", "list");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern inspect: permission denied" });
  assert.deepEqual(w.calls(), [["inspect", "--json"]]);
});

test("EAGAIN from send keys is never retried", (t) => {
  const w = world(t, { 13: orchestrator() }, {
    fakeTime: true,
    failure: { command: "send", remaining: 1, message: "os error 35" },
  });
  const r = w.run("agent", "send-keys", "13", "enter");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern send: os error 35" });
  assert.equal(sends(w).length, 1);
});

test("EAGAIN from a prompt paste is never retried", (t) => {
  const w = worker(t, { fakeTime: true });
  w.edit((x) => { x.failure = { command: "send", remaining: 1, message: "Resource temporarily unavailable" }; });
  const r = w.run("agent", "prompt", "app-work-1-1", "Do this once");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern send: Resource temporarily unavailable" });
  assert.deepEqual(sends(w), [["send", "50", "paste", "Do this once"]]);
});

test("EAGAIN from pane run is never retried", (t) => {
  const w = world(t, { 13: orchestrator() }, {
    fakeTime: true,
    failure: { command: "run", remaining: 1, message: "os error 35" },
  });
  const r = w.run("pane", "run", "13", "echo once");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern run: os error 35" });
  assert.deepEqual(w.calls(), [["run", "13", "echo once"]]);
});

test("EAGAIN from pane split is never retried", (t) => {
  const w = world(t, { 13: orchestrator() }, {
    fakeTime: true,
    failure: { command: "split", remaining: 1, message: "Resource temporarily unavailable" },
  });
  const r = w.run("pane", "split", "13", "--direction", "right");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern split: Resource temporarily unavailable" });
  assert.equal(w.calls().filter((c) => c[0] === "split").length, 1);
});

test("EAGAIN from pane close is never retried", (t) => {
  const w = world(t, { 13: orchestrator() }, {
    fakeTime: true,
    failure: { command: "close", remaining: 1, message: "os error 35" },
  });
  const r = w.run("pane", "close", "13");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern close: os error 35" });
  assert.deepEqual(w.calls(), [["close", "13"]]);
});

test("EAGAIN from tab rename is never retried", (t) => {
  const w = world(t, { 13: orchestrator() }, {
    fakeTime: true,
    failure: { command: "rename", remaining: 1, message: "os error 35" },
  });
  const r = w.run("tab", "rename", "13", "Once");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern rename: os error 35" });
  assert.equal(w.calls().filter((c) => c[0] === "rename").length, 1);
});

test("a process read recovers after EAGAIN", (t) => {
  const w = world(t, { 13: orchestrator() }, {
    failure: { command: "process", remaining: 2, message: "os error 35" },
  });
  const r = w.run("agent", "get", "13");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agent.pid, 2);
  assert.equal(w.calls().filter((c) => c[0] === "process").length, 3);
});

test("a capture read recovers after EAGAIN", (t) => {
  const w = world(t, { 13: { ...orchestrator(), scrollback: "Captured chat\n" } }, {
    failure: { command: "capture", remaining: 2, message: "Resource temporarily unavailable" },
  });
  const r = w.run("agent", "read", "13");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "Captured chat\n");
  assert.equal(w.calls().filter((c) => c[0] === "capture").length, 3);
});

test("a version read recovers after EAGAIN", (t) => {
  const w = world(t, {}, {
    failure: { command: "--version", remaining: 2, message: "os error 35" },
  });
  const r = w.run("integration", "status");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /tern 0\.9\.2/);
  assert.equal(w.calls().length, 3);
});

test("a wait with --timeout stops retrying a busy daemon at its own timeout", (t) => {
  const w = worker(t, { fakeTime: true });
  w.edit((x) => { x.failure = { command: "inspect", skip: 1, remaining: 1000, message: "os error 35" }; });
  const r = w.run("agent", "wait", "app-work-1-1", "--until", "working", "--timeout", "1000");
  assert.equal(r.error?.code, "timeout", r.stderr);
  assert.equal(w.sleeps().reduce((sum, ms) => sum + ms, 0), 1000);
});

test("a wait whose --timeout ends with the retry budget reports timeout", (t) => {
  const w = worker(t, { fakeTime: true });
  w.edit((x) => { x.failure = { command: "inspect", skip: 1, remaining: 1000, message: "os error 35" }; });
  const r = w.run("agent", "wait", "app-work-1-1", "--until", "working", "--timeout", "60000");
  assert.equal(r.error?.code, "timeout", r.stderr);
});

test("a wait whose --timeout runs out on a busy process read reports timeout, not an exit", (t) => {
  const w = worker(t, { fakeTime: true });
  w.edit((x) => { x.failure = { command: "process", skip: 1, remaining: 30, message: "os error 35" }; });
  const r = w.run("agent", "wait", "app-work-1-1", "--until", "idle", "--timeout", "1000");
  assert.equal(r.error?.code, "timeout", r.stderr);
  assert.equal(w.calls().filter((c) => c[0] === "inspect").length, 2, "a process timeout does not trigger a fresh absence check");
});

test("a busy daemon at the prompt gate does not read as a prompt that never landed", (t) => {
  const w = worker(t, { fakeTime: true });
  // Resolving, the paste and the Enter take four reads; the fifth is the gate's.
  w.edit((x) => { x.failure = { command: "inspect", skip: 4, remaining: 30, message: "os error 35" }; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go", "--wait");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agent.agent_status, "done");
  assert.equal(w.read().failure.remaining, 0);
});

test("a prompt whose --timeout runs out while the daemon is busy at the gate reports timeout", (t) => {
  const w = worker(t, { fakeTime: true });
  w.edit((x) => { x.failure = { command: "inspect", skip: 4, remaining: 1000, message: "os error 35" }; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go", "--wait", "--timeout", "8000");
  assert.equal(r.error?.code, "timeout", r.stderr);
});

test("a prompt gate's busy process read preserves the caller timeout and worker", (t) => {
  const w = worker(t, { fakeTime: true });
  const record = w.record(50);
  w.edit((x) => {
    x.panes[50].afterEnter = Array(20).fill("working");
    x.panes[50].failureAfterEnter = { command: "process", skip: 1, remaining: 1000, message: "os error 35" };
  });
  const r = w.run("agent", "prompt", "app-work-1-1", "go", "--wait", "--timeout", "8000");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "timeout", r.stderr);
  assert.equal(w.sleeps().reduce((sum, ms) => sum + ms, 0), 8000);
  assert.equal(w.calls().at(-1)[0], "process", "timeout propagates before a fresh inspect");
  assert.deepEqual(sends(w), [["send", "50", "paste", "go"], ["send", "50", "keys", "Enter"]]);
  assert.equal(w.read().panes[50].prompts, 1);
  assert.ok(existsSync(record));
  w.edit((x) => { x.failure.remaining = 0; });
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
});

test("a read after agent start's wait keeps the full retry budget", (t) => {
  const w = lane(t, { fakeTime: true });
  // A name an earlier omp in pane 13 held, so the claim re-reads pane 13 after the wait.
  assert.equal(w.run("agent", "rename", "13", "app-work-1-1").code, 0);
  w.edit((x) => { x.panes[13].child = omp(99); x.panes[13].foreground = omp(99); });
  // Checking the name and the wait take two reads; the third is the claim's.
  w.edit((x) => { x.failure = { command: "inspect", skip: 2, remaining: 5, message: "os error 35" }; });
  const r = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50", "--timeout", "1000");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agent.name, "app-work-1-1");
  assert.equal(w.read().failure.remaining, 0);
});

test("renaming an agent to the name it already holds succeeds", (t) => {
  const w = world(t, { 13: orchestrator() });
  assert.equal(w.run("agent", "rename", "13", "app-orch-1").code, 0);
  const again = w.run("agent", "rename", "13", "app-orch-1");
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.result.agent.name, "app-orch-1");
});

test("agent read without --lines prints the whole capture, and a bad --lines is a syntax error", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].screen = "s1\ns2\ns3\n"; });
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, "s1\ns2\ns3\n");
  assert.equal(w.run("agent", "read", "app-work-1-1", "--lines", "two").code, 2);
  assert.equal(w.run("agent", "read", "app-work-1-1", "--lines", "-1").code, 2);
});

test("tab rename of an id that is neither a block nor a tab fails with tab_not_found", (t) => {
  const w = world(t, { 13: orchestrator() });
  const r = w.run("tab", "rename", "999", "x");
  assert.equal(r.error?.code, "tab_not_found");
  assert.ok(!w.calls().some((c) => c[0] === "rename"));
});

test("agent wait rejects --until unknown, a state no wait can settle on", (t) => {
  const w = worker(t);
  assert.equal(w.run("agent", "wait", "app-work-1-1", "--until", "unknown").code, 2);
});

test("a pane Tern reports without a title does not break agent list", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].title = null; });
  const r = w.run("agent", "list");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.result.agents.map((a) => [a.pane_id, a.agent_status]), [["13", "working"], ["50", "idle"]]);
});

test("a pane missing from one inspect fails the prompt before the paste, and keeps the name", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].missingOnInspect = 1; });
  assert.equal(w.run("agent", "prompt", "app-work-1-1", "go").error?.code, "agent_not_found");
  assert.deepEqual(sends(w), [], "nothing was typed");
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.agent_status, "idle", "the worker is still reachable by name");
});

test("agent get by name reports a failed process query without losing the worker or its record", (t) => {
  const w = worker(t);
  const record = w.record(50);
  w.edit((x) => { x.panes[50].processFails = 1; });
  const r = w.run("agent", "get", "app-work-1-1");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern process: the session daemon did not answer" });
  assert.ok(existsSync(record), "an unavailable process query does not remove the surface record");
  const recovered = w.run("agent", "get", "app-work-1-1");
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.json.result.agent.pane_id, "50");
  assert.equal(recovered.json.result.agent.name, "app-work-1-1");
  assert.equal(recovered.json.result.agent.agent_status, "idle");
});

test("agent get by pane propagates process failure and preserves named recovery", (t) => {
  const w = worker(t);
  const record = w.record(50);
  w.edit((x) => { x.panes[50].processFails = 1; });
  const r = w.run("agent", "get", "50");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern process: the session daemon did not answer" });
  assert.ok(existsSync(record));
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
});

test("agent list fails as a whole when a shown worker's process query fails", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].processFails = 1; });
  const r = w.run("agent", "list");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern process: the session daemon did not answer" });
  assert.equal(r.json, undefined, "no partial successful list is emitted");
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
});

test("agent rename cannot steal a name whose holder's process query fails", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].processFails = 1; });
  const r = w.run("agent", "rename", "13", "app-work-1-1");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "tern_failed");
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
});

test("agent start cannot steal an unavailable holder's name or type into its target pane", (t) => {
  const w = worker(t);
  w.edit((x) => {
    x.panes[51] = { tab: 6, title: "zsh", cwd: "/repo/wt", child: shell(61), foreground: shell(61) };
    x.panes[50].processFails = 100;
  });
  const r = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "51");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "tern_failed");
  assert.ok(!w.calls().some((c) => c[0] === "send" || c[0] === "run"), "no input or launch reached the target pane");
  w.edit((x) => { x.panes[50].processFails = 0; });
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
});

test("agent read propagates a failed process lookup instead of capturing", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].processFails = 1; });
  const r = w.run("agent", "read", "app-work-1-1", "--source", "visible");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "tern_failed");
  assert.ok(!w.calls().some((c) => c[0] === "capture"));
});

test("agent send-keys propagates a failed lookup before sending keys", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].processFails = 1; });
  const r = w.run("agent", "send-keys", "app-work-1-1", "enter");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "tern_failed");
  assert.deepEqual(sends(w), []);
});

test("agent wait reports persistent process failure while retaining the name and record", (t) => {
  const w = worker(t);
  const record = w.record(50);
  w.edit((x) => { x.panes[50].processFails = 100; });
  const r = w.run("agent", "wait", "app-work-1-1", "--timeout", "1000");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "tern_failed");
  assert.ok(existsSync(record));
  w.edit((x) => { x.panes[50].processFails = 0; });
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
});

test("agent get treats a pane absent from fresh inspect after process failure as absent", (t) => {
  const w = worker(t);
  const record = w.record(50);
  w.edit((x) => { x.panes[50].processFails = 1; x.panes[50].missingOnInspect = 2; });
  const r = w.run("agent", "get", "app-work-1-1");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "agent_not_found");
  assert.ok(existsSync(record));
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
});

test("a pane absent from fresh inspect keeps its name even when a later process query shows a shell", (t) => {
  const w = worker(t);
  const record = w.record(50);
  const name = join(w.stateDir, "names", "app-work-1-1.json");
  // The fresh inspect after the failed process query omits the pane while omp
  // has left it, so only a stale view would go on to ask Tern for its foreground.
  w.edit((x) => { x.panes[50].processFails = 1; x.panes[50].missingOnInspect = 2; x.panes[50].exitAfterInspects = 2; });
  const r = w.run("agent", "get", "app-work-1-1");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "agent_not_found");
  assert.ok(existsSync(name), "a pane absent from inspect keeps its name");
  assert.ok(existsSync(record), "a pane absent from inspect keeps its surface record");
  // Once inspect shows the pane again with a shell in front, the name is cleared.
  assert.equal(w.run("agent", "get", "app-work-1-1").error?.code, "agent_not_found");
  assert.ok(!existsSync(name));
  assert.ok(!existsSync(record));
});

test("agent list omits a pane absent from fresh inspect after process failure", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].processFails = 1; x.panes[50].missingOnInspect = 2; });
  const r = w.run("agent", "list");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.result.agents.map((a) => a.pane_id), ["13"]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
});

test("agent prompt reports process failure after a lost Enter with a composer warning", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].enterLost = true; x.panes[50].failureAfterEnter = { command: "process", remaining: 100, message: "the session daemon did not answer" }; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "tern_failed");
  assert.match(r.error.message, /tern process: the session daemon did not answer/);
  assert.match(r.error.message, /read the pane/i);
  assert.match(r.error.message, /unsent|composer/i);
  assert.deepEqual(sends(w), [["send", "50", "paste", "go"], ["send", "50", "keys", "Enter"]]);
  w.edit((x) => { x.failure.remaining = 0; });
  assert.match(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, /> go/);
});

test("agent prompt reports process failure after paste without pressing Enter and warns about unsent text", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].failureAfterPaste = { command: "process", remaining: 100, message: "the session daemon did not answer" }; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "tern_failed");
  assert.match(r.error.message, /tern process: the session daemon did not answer/);
  assert.match(r.error.message, /read the pane/i);
  assert.match(r.error.message, /unsent|composer/i);
  assert.deepEqual(sends(w), [["send", "50", "paste", "go"]]);
  w.edit((x) => { x.failure.remaining = 0; });
  assert.match(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, /> go/);
});

test("agent prompt warns about observed unsent text when its final pre-Enter process query fails", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].failureAfterPaste = { command: "process", remaining: 100, skip: 1, message: "the session daemon did not answer" }; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "tern_failed");
  assert.match(r.error.message, /tern process: the session daemon did not answer/);
  assert.match(r.error.message, /read the pane/i);
  assert.match(r.error.message, /sits unsent/i);
  assert.deepEqual(sends(w), [["send", "50", "paste", "go"]], "the failed final guard sends no Enter");
  w.edit((x) => { x.failure.remaining = 0; });
  assert.match(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, /> go/);
});

test("agent start tolerates one failed process query during readiness and claims the ready worker", (t) => {
  const w = lane(t, { launch: { ...ready, failureAfterRun: { command: "process", remaining: 1, message: "the session daemon did not answer" } } });
  const r = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agent.agent_status, "idle");
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
});

test("blocked send-keys succeeds when its postkeys process query fails", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].states = ["blocked"]; x.panes[50].failureAfterEnter = { command: "process", remaining: 1, message: "the session daemon did not answer" }; });
  const r = w.run("agent", "send-keys", "app-work-1-1", "enter");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.result.keys, ["Enter"]);
  assert.deepEqual(sends(w), [["send", "50", "keys", "Enter"]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.agent_status, "idle");
});

for (const fresh of [false, true]) {
  test(`agent start propagates ${fresh ? "fresh " : ""}inspect failure during readiness`, (t) => {
    const inspectFailure = { command: "inspect", remaining: 1, message: "inspect unavailable" };
    const launch = { ...ready, failureAfterRun: fresh ? { command: "process", remaining: 1, message: "the session daemon did not answer", after: inspectFailure } : inspectFailure };
    const w = lane(t, { launch });
    const r = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50", "--timeout", "1000");
    assert.equal(r.code, 1);
    assert.deepEqual(r.error, { code: "tern_failed", message: "tern inspect: inspect unavailable" });
  });

  test(`blocked send-keys propagates ${fresh ? "fresh " : ""}inspect failure after keys land`, (t) => {
    const w = worker(t);
    w.edit((x) => {
      const p = x.panes[50];
      p.states = ["blocked"];
      const inspectFailure = { command: "inspect", remaining: 1, message: "inspect unavailable" };
      p.failureAfterEnter = fresh ? { command: "process", remaining: 1, message: "the session daemon did not answer", after: inspectFailure } : inspectFailure;
    });
    const r = w.run("agent", "send-keys", "app-work-1-1", "enter");
    assert.equal(r.code, 1);
    assert.deepEqual(r.error, { code: "tern_failed", message: "tern inspect: inspect unavailable" });
    assert.deepEqual(sends(w), [["send", "50", "keys", "Enter"]]);
  });
}

test("agent prompt propagates process lookup failure before paste without sending input", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].processFails = 1; });
  const r = w.run("agent", "prompt", "app-work-1-1", "go");
  assert.equal(r.code, 1);
  assert.deepEqual(r.error, { code: "tern_failed", message: "tern process: the session daemon did not answer" });
  assert.deepEqual(sends(w), []);
});

test("agent wait propagates process failure after it has begun waiting", (t) => {
  const w = worker(t);
  const record = w.record(50);
  w.edit((x) => { x.panes[50].states = Array(20).fill("working"); x.failure = { command: "process", remaining: 100, skip: 2, message: "the session daemon did not answer" }; });
  const r = w.run("agent", "wait", "app-work-1-1", "--timeout", "2000");
  assert.equal(r.code, 1);
  assert.equal(r.error?.code, "tern_failed");
  assert.ok(existsSync(record));
  w.edit((x) => { x.failure.remaining = 0; });
  assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
});

for (const [phase, skip] of [["activity gate", 1], ["turn settlement", 2]]) {
  test(`agent prompt --wait propagates midwait process failure during ${phase}`, (t) => {
    const w = worker(t);
    w.edit((x) => {
      x.panes[50].afterEnter = Array(20).fill("working");
      x.panes[50].failureAfterEnter = { command: "process", remaining: 100, skip, message: "the session daemon did not answer" };
    });
    const r = w.run("agent", "prompt", "app-work-1-1", "go", "--wait", "--timeout", "2000");
    assert.equal(r.code, 1);
    assert.equal(r.error?.code, "tern_failed");
    assert.match(r.error.message, /tern process: the session daemon did not answer/);
    assert.match(r.error.message, /read the pane/i);
    assert.match(r.error.message, /composer/i);
    assert.deepEqual(sends(w), [["send", "50", "paste", "go"], ["send", "50", "keys", "Enter"]]);
    assert.equal(w.read().panes[50].prompts, 1, "the turn started before its wait failed");
    w.edit((x) => { x.failure.remaining = 0; });
    assert.equal(w.run("agent", "get", "app-work-1-1").json?.result.agent.pane_id, "50");
  });
}

test("tern process calls that fail for a moment do not cost a live worker its name", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].processFails = 1; });
  assert.equal(w.run("agent", "get", "app-work-1-1").error?.code, "tern_failed");
  assert.equal(w.run("agent", "prompt", "app-work-1-1", "go", "--wait").json?.result.agent.agent_status, "done");
});

// The prompt's own reads take a few seconds before the gate starts, so the turn
// starts ten seconds after the Enter to land past a five-second gate.
test("agent prompt --wait gives the first skill prompt time to start ten seconds after the Enter", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].skillCard = true; x.panes[50].turnDelayMs = 10_000; });
  const [r, took] = timed(() => w.run("agent", "prompt", "app-work-1-1", "/skill:implement issue://4 fix the worker", "--wait"));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agent.agent_status, "done");
  assert.ok(took > 9500, `the first prompt waited for the delayed turn (${took}ms)`);
});

test("a legacy v3 replay cache at EOF recounts skill cards", (t) => {
  const w = worker(t);
  w.frame(50, [["add", "legacy-skill", "main", null, { id: "legacy-skill", k: "card", p: { role: "omp.skill" } }]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").code, 0);
  const cache = join(w.stateDir, "replays", readdirSync(join(w.stateDir, "replays"))[0]);
  const doc = JSON.parse(readFileSync(cache, "utf8"));
  assert.equal(doc.prompts, 1);
  assert.equal(doc.offset, Buffer.byteLength(readFileSync(w.record(50))));
  doc.v = 3;
  doc.prompts = 0;
  writeFileSync(cache, JSON.stringify(doc));

  const r = w.run("agent", "get", "app-work-1-1");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(cache, "utf8")).prompts, 1, "legacy count must be refreshed");
});

test("agent prompt --wait reads a later skill turn that ended before its first read as done", (t) => {
  const w = worker(t);
  const first = w.run("agent", "prompt", "app-work-1-1", "go", "--wait");
  assert.equal(first.json?.result.agent.agent_status, "done", first.stderr);
  w.edit((x) => { x.panes[50].skillCard = true; x.panes[50].afterEnter = ["idle"]; });
  const r = w.run("agent", "prompt", "app-work-1-1", "/skill:implement issue://4 fix the worker", "--wait");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.result.agent.agent_status, "done");
});

test("agent prompt --wait stalls after five seconds when a later turn takes ten seconds to start", (t) => {
  const w = worker(t);
  const first = w.run("agent", "prompt", "app-work-1-1", "go", "--wait");
  assert.equal(first.json?.result.agent.agent_status, "done", first.stderr);
  w.edit((x) => { x.panes[50].turnDelayMs = 10_000; });
  const [r, took] = timed(() => w.run("agent", "prompt", "app-work-1-1", "go again", "--wait"));
  assert.equal(r.error?.code, "agent_prompt_stalled", r.stderr);
  assert.match(r.error.message, /no activity within 5000ms/);
  assert.ok(took >= 5000, `the later prompt waited out its five-second gate (${took}ms)`);
});

test("agent prompt --wait reports a twenty-second stall when omp takes its first prompt but starts nothing", (t) => {
  const w = worker(t, { fakeTime: true });
  w.edit((x) => { x.panes[50].noTurn = true; });
  const r = w.run("agent", "prompt", "app-work-1-1", "/nothing", "--wait");
  assert.equal(r.error?.code, "agent_prompt_stalled", r.stderr);
  assert.match(r.error.message, /no activity within 20000ms/);
});

test("agent prompt --wait reports a five-second stall when omp takes a later prompt but starts nothing", (t) => {
  const w = worker(t, { fakeTime: true });
  const first = w.run("agent", "prompt", "app-work-1-1", "go", "--wait");
  assert.equal(first.json?.result.agent.agent_status, "done", first.stderr);
  w.edit((x) => { x.panes[50].noTurn = true; });
  const r = w.run("agent", "prompt", "app-work-1-1", "/nothing", "--wait");
  assert.equal(r.error?.code, "agent_prompt_stalled", r.stderr);
  assert.match(r.error.message, /no activity within 5000ms/);
});

test("an eight-second timeout ends the first prompt before its twenty-second activity gate", (t) => {
  const w = worker(t, { fakeTime: true });
  w.edit((x) => { x.panes[50].noTurn = true; });
  const r = w.run("agent", "prompt", "app-work-1-1", "/nothing", "--wait", "--timeout", "8000");
  assert.equal(r.error?.code, "timeout", r.stderr);
});

test("agent start gives a relaunched omp its twenty-second first-prompt gate in the same pane and name", (t) => {
  const w = worker(t, { fakeTime: true });
  const first = w.run("agent", "prompt", "app-work-1-1", "go", "--wait");
  assert.equal(first.json?.result.agent.agent_status, "done", first.stderr);
  w.edit((x) => { x.panes[50].states = ["exit"]; });
  assert.equal(w.run("agent", "get", "app-work-1-1").error?.code, "agent_not_found");
  w.edit((x) => { x.launch = { ...x.launch, pid: 4243, session: "/s/restarted-worker.jsonl" }; });
  const restarted = w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50");
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.equal(restarted.json.result.agent.pane_id, "50");
  w.edit((x) => { x.panes[50].noTurn = true; });
  const r = w.run("agent", "prompt", "app-work-1-1", "/nothing", "--wait");
  assert.equal(r.error?.code, "agent_prompt_stalled", r.stderr);
  assert.match(r.error.message, /20000ms/);
});

test("a --timeout shorter than the activity gate ends the prompt with timeout", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].noTurn = true; });
  assert.equal(w.run("agent", "prompt", "app-work-1-1", "/nothing", "--wait", "--timeout", "300").error?.code, "timeout");
});

// Right after a turn omp has taken five seconds to show a paste.
test("agent prompt waits past a second for a paste and an Enter that omp takes late", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].echoDelayMs = 1500; x.panes[50].submitDelayMs = 1500; });
  const [r, took] = timed(() => w.run("agent", "prompt", "app-work-1-1", "go", "--wait"));
  assert.equal(r.json?.result.agent.agent_status, "done", r.stderr);
  assert.ok(took > 2500, `the waits outlasted a second each (${took}ms)`);
  assert.ok(!w.read().panes[50].enterBeforeEcho, "the Enter waited for the paste to show");
  assert.equal(w.read().panes[50].prompts, 1);
});

test("a sheet omp opens in the layer, such as the plan review, reads as blocked and shows its choices", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].screen = ""; });
  w.frame(50, [["add", "ov", "layer", null, { id: "ov", k: "overlay", p: { role: "omp.overlay.planReview" }, c: [
    { id: "ov.l", k: "list", p: { selected: "ov.l/0" }, c: [{ id: "ov.l/0", k: "item", p: { label: [{ t: "Approve and execute" }] } }, { id: "ov.l/1", k: "item", p: { label: [{ t: "Refine plan" }] } }] }] }]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "blocked");
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, "› Approve and execute\n  Refine plan\n");
  assert.equal(w.run("agent", "prompt", "app-work-1-1", "go").error?.code, "agent_blocked");
  w.frame(50, [["del", "ov"], ["add", "ac", "layer", null, { id: "ac", k: "overlay", p: { role: "omp.autocomplete" } }]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "idle", "the slash-command menu is no dialog");
});

test("a full-screen surface omp opens reads as blocked and shows its text, and its close leaves the session", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].screen = ""; });
  w.message(50, "o", { id: "s:2", mode: "screen", role: "omp.session" });
  w.frame(50, [["add", "main", "s:2", null, { id: "main", k: "col", c: [{ id: "w", k: "md", p: { text: "Welcome. Pick a provider" } }] }]], { sf: "s:2" });
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "blocked");
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, "Welcome. Pick a provider\n");
  w.message(50, "x", { id: "s:2" });
  w.frame(50, [["text", "j.line/input", "append", "still here"]]);
  assert.equal(w.run("agent", "get", "app-work-1-1").json.result.agent.agent_status, "idle");
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, "> still here\n");
});

test("a read waits for the frames omp holds back for a full-screen surface too", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].screen = ""; });
  w.message(50, "o", { id: "s:2", mode: "screen", role: "omp.session" });
  w.frame(50, [["add", "main", "s:2", null, { id: "main", k: "col", c: [{ id: "w", k: "md", p: { text: "Loading" } }] }]], { sf: "s:2", acked: false, t: -2500 });
  w.frame(50, [], { sf: "s:2", acked: false, t: -2400 });
  flushLater(w, 600, 2500, [["set", "w", { text: "Pick a provider" }]], "s:2");
  const [r, took] = timed(() => w.run("agent", "read", "app-work-1-1", "--source", "visible"));
  assert.equal(r.stdout, "Pick a provider\n");
  assert.ok(took < 2000, `the read returned once omp sent what it held (${took}ms)`);
});

test("agent read leaves out the dock of a worker that closed its surface", (t) => {
  const w = worker(t);
  w.edit((x) => { x.panes[50].screen = "bye\n"; });
  w.frame(50, [["text", "j.line/input", "append", "unsent"]]);
  w.message(50, "x", { id: "s:1", keep: true });
  assert.equal(w.run("agent", "read", "app-work-1-1", "--source", "visible").stdout, "bye\n");
});

test("agent start clears what an earlier keystroke left on the shell's input line", (t) => {
  const w = lane(t);
  w.edit((x) => { x.panes[50].lineBuffer = "rm -rf build"; });
  assert.equal(w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50").code, 0);
  assert.ok(!w.read().panes[50].executed.some((c) => c.includes("rm -rf build")), "the leftover text was not run");
});

test("agent start runs no line of a multi-line leftover on the shell's input", (t) => {
  const w = lane(t);
  w.edit((x) => { x.panes[50].lineBuffer = "echo LINE1\necho LINE2"; });
  assert.equal(w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50").code, 0);
  assert.ok(!w.read().panes[50].executed.some((c) => /LINE[12]/.test(c)), "no leftover line was run");
});

// orchestrate types `cd WT` into a fresh pane and starts the worker at once.
test("agent start does not interrupt a shell that is still loading its rc file", (t) => {
  const w = lane(t);
  w.edit((x) => { x.panes[50].rcLoading = true; });
  assert.equal(w.run("agent", "start", "app-work-1-1", "--kind", "omp", "--pane", "50").code, 0);
  assert.ok(!w.read().panes[50].rcAborted, "the rc file ran to its end");
});

test("agent start clears the names of workers that left, and the records no name holds once still for ten minutes", (t) => {
  const sh = (pid) => ({ tab: 6, title: "zsh", cwd: "/r", child: shell(pid), foreground: shell(pid) });
  const w = world(t, { 13: orchestrator(), 50: sh(60), 51: sh(61), 52: sh(62), 53: sh(63), 54: sh(64) }, { launch: ready });
  const start = (name, pane, pid) => {
    w.edit((x) => { x.launch = { ...ready, pid }; });
    assert.equal(w.run("agent", "start", name, "--kind", "omp", "--pane", pane).code, 0);
    return w.record(pane);
  };
  const old = (Date.now() - 11 * 60_000) / 1000;
  const live = start("app-work-1-1", "50", 4001);
  utimesSync(live, old, old);
  const left = start("app-work-1-2", "51", 4002);
  w.edit((x) => { x.panes[51].foreground = shell(61); });
  const unseen = start("app-work-1-3", "52", 4003);
  const unseenStill = start("app-work-1-4", "53", 4004);
  w.edit((x) => { delete x.panes[52]; delete x.panes[53]; });
  utimesSync(unseenStill, old, old);
  const records = join(w.stateDir, "records");
  writeFileSync(join(records, "77-1-1.jsonl"), "");
  utimesSync(join(records, "77-1-1.jsonl"), old, old);
  writeFileSync(join(records, "78-1-1.jsonl"), "");
  start("app-work-1-5", "54", 4005);
  assert.ok(existsSync(live), "a still record of a live worker was kept");
  assert.ok(!existsSync(left), "the record of a worker whose omp left its pane was removed");
  assert.ok(existsSync(unseen), "a fresh record of a pane Tern does not find was kept");
  assert.ok(!existsSync(unseenStill), "a still record of a pane Tern does not find was removed");
  assert.ok(!existsSync(join(records, "77-1-1.jsonl")), "a still record no name holds was removed");
  assert.ok(existsSync(join(records, "78-1-1.jsonl")), "a record changed lately was kept");
  assert.deepEqual(readdirSync(join(w.stateDir, "names")).sort(), ["app-work-1-1.json", "app-work-1-3.json", "app-work-1-5.json"]);
});
