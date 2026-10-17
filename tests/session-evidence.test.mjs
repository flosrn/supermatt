import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (...parts) => join(here, "fixtures", "session-evidence", ...parts);
const script = resolve(here, "../skills/retro/scripts/session-evidence.mjs");

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "session-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(fixture(from), to);
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function texts(output) {
  return output.sessions.flatMap(({ records }) => records.map(({ text }) => text));
}

test("Claude normalizes failed tool results", (t) => {
  const home = workspace(t);
  const session = join(home, ".claude", "projects", "-workspace-project", "claude-session.jsonl");
  copy("claude-main.jsonl", session);

  const result = run(["--host", "claude", "--cwd", "/workspace/project", "--session", session], { HOME: home });

  assert.equal(result.status, 0, result.stderr);
  const records = JSON.parse(result.stdout).sessions[0].records;
  assert.deepEqual(records.map(({ kind, text }) => ({ kind, text })), [
    { kind: "user", text: "Claude user marker" },
    { kind: "assistant", text: "Claude assistant marker" },
    { kind: "tool-error", text: "Claude failed tool" },
  ]);
});

test("Claude rejects a transcript from another workspace", (t) => {
  const home = workspace(t);
  const session = join(home, ".claude", "projects", "-workspace-other", "claude-session.jsonl");
  copy("claude-other.jsonl", session);

  const result = run(["--host", "claude", "--cwd", "/workspace/project", "--session", session], { HOME: home });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mismatched claude transcript/);
});

test("Codex preserves distinct failed calls with identical output", (t) => {
  const home = workspace(t);
  const session = join(home, ".codex", "sessions", "codex-session.jsonl");
  copy("codex-main.jsonl", session);

  const result = run(["--host", "codex", "--cwd", "/workspace/project", "--session", session], { HOME: home });

  assert.equal(result.status, 0, result.stderr);
  const records = JSON.parse(result.stdout).sessions[0].records;
  assert.deepEqual(records.map(({ kind, text }) => ({ kind, text })), [
    { kind: "user", text: "Codex user marker" },
    { kind: "assistant", text: "Codex assistant marker" },
    { kind: "tool-error", text: "Codex failed tool" },
    { kind: "tool-error", text: "Codex failed tool" },
  ]);
  assert.deepEqual(records.filter(({ kind }) => kind === "tool-error").map(({ line }) => line), [4, 5]);
});

test("Codex rejects a transcript from another workspace", (t) => {
  const home = workspace(t);
  const session = join(home, ".codex", "sessions", "codex-session.jsonl");
  copy("codex-other.jsonl", session);

  const result = run(["--host", "codex", "--cwd", "/workspace/project", "--session", session], { HOME: home });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mismatched codex transcript/);
});

test("Cursor reads only the verified workspace session and its child evidence", (t) => {
  const home = workspace(t);
  const session = "cursor-session";
  const base = join(home, ".cursor/projects/workspace-project-test/agent-transcripts", session);
  copy("cursor-main.jsonl", join(base, `${session}.jsonl`));
  copy("cursor-subagent.jsonl", join(base, "subagents/child.jsonl"));
  copy("cursor-compaction.md", join(base, "compaction/segment_000.md"));
  copy("cursor-other.jsonl", join(home, ".cursor/projects/workspace-other/agent-transcripts/newer/newer.jsonl"));

  const result = run(["--host", "cursor", "--cwd", "/workspace/project.test", "--session", session], { HOME: home });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.host, "cursor");
  assert.equal(output.sessions.length, 3);
  assert.deepEqual(output.gaps, []);
  assert.deepEqual(texts(output), [
    "Cursor verified user marker",
    "Cursor main answer",
    "Cursor failed tool",
    "Cursor child answer",
    "# Compaction summary\n\nCursor compacted evidence.",
  ]);
  assert.equal(output.sessions.every(({ path }) => path.startsWith(realpathSync(base))), true);
});

test("OMP follows the active branch and includes associated child transcripts", (t) => {
  const home = workspace(t);
  const sessionRoot = join(home, ".omp/agent/sessions");
  const main = join(sessionRoot, "-workspace-project/session.jsonl");
  copy("omp-main.jsonl", main);
  copy("omp-child.jsonl", join(sessionRoot, "-workspace-project/session/child.jsonl"));

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main], {
    HOME: home,
    PI_CODING_AGENT_SESSION_DIR: sessionRoot,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sessions.length, 2);
  assert.deepEqual(texts(output), [
    "OMP verified user marker",
    "OMP main answer",
    "OMP failed tool",
    "OMP compacted evidence",
    "OMP final answer",
    "OMP child answer",
  ]);
  assert.equal(texts(output).includes("OMP abandoned answer"), false);
  assert.equal(output.sessions[0].records.find(({ text }) => text === "OMP failed tool").kind, "tool-error");
});

test("OMP accepts sessions from its XDG data root", (t) => {
  const home = workspace(t);
  const xdgData = join(home, "xdg-data");
  const main = join(xdgData, "omp/sessions/-workspace-project/session.jsonl");
  copy("omp-main.jsonl", main);

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main], {
    HOME: home,
    XDG_DATA_HOME: xdgData,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sessions[0].path, realpathSync(main));
});

test("OMP treats an explicit null active leaf as cleared history", (t) => {
  const home = workspace(t);
  const sessionRoot = join(home, ".omp/agent/sessions");
  const main = join(sessionRoot, "-workspace-project/session.jsonl");
  copy("omp-null-leaf.jsonl", main);

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main], {
    HOME: home,
    PI_CODING_AGENT_SESSION_DIR: sessionRoot,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported OMP transcript schema/);
});

test("OMP falls back when a persisted active leaf no longer exists", (t) => {
  const home = workspace(t);
  const sessionRoot = join(home, ".omp/agent/sessions");
  const main = join(sessionRoot, "-workspace-project/session.jsonl");
  copy("omp-missing-leaf.jsonl", main);

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main], {
    HOME: home,
    PI_CODING_AGENT_SESSION_DIR: sessionRoot,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(texts(JSON.parse(result.stdout)), ["Fallback OMP user", "Fallback OMP answer"]);
});

test("OMP rejects an associated child transcript from another workspace", (t) => {
  const home = workspace(t);
  const sessionRoot = join(home, ".omp/agent/sessions");
  const main = join(sessionRoot, "-workspace-project/session.jsonl");
  copy("omp-main.jsonl", main);
  copy("omp-child-other.jsonl", join(sessionRoot, "-workspace-project/session/child.jsonl"));

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main], {
    HOME: home,
    PI_CODING_AGENT_SESSION_DIR: sessionRoot,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mismatched OMP transcript/);
});

test("Cursor rejects paths outside the verified workspace", (t) => {
  const home = workspace(t);
  const outside = join(home, "outside/session.jsonl");
  copy("cursor-main.jsonl", outside);
  const result = run(["--host", "cursor", "--cwd", "/workspace/project", "--session", outside], { HOME: home });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the verified Cursor workspace root/);
});

test("requested malformed and unidentified sessions fail closed", (t) => {
  const home = workspace(t);
  const base = join(home, ".cursor/projects/workspace-project/agent-transcripts");
  const malformed = join(base, "bad/bad.jsonl");
  mkdirSync(dirname(malformed), { recursive: true });
  writeFileSync(malformed, "{not json}\n");

  const bad = run(["--host", "cursor", "--cwd", "/workspace/project", "--session", "bad"], { HOME: home });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /malformed JSONL/);

  const missing = run(["--host", "cursor", "--cwd", "/workspace/project", "--session", "missing"], { HOME: home });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /cannot identify requested Cursor session/);
});
