import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    { kind: "tool-error", text: "Claude nested failure\nNested failure detail" },
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
  copy("omp-abandoned-child.jsonl", join(sessionRoot, "-workspace-project/session/abandoned.jsonl"));

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
  assert.deepEqual(output.gaps, []);
  assert.equal(output.sessions.filter(({ path }) => path.endsWith("/abandoned.jsonl")).length, 0);
  assert.equal(output.sessions.flatMap(({ records }) => records).filter(({ kind }) => kind === "tool-error").length, 1);
});

test("OMP accepts skill-prompt-only user input and skips unrelated custom messages", (t) => {
  const home = workspace(t);
  const sessionRoot = join(home, ".omp/agent/sessions");
  const main = join(sessionRoot, "-workspace-project/session.jsonl");
  copy("omp-skill-prompt.jsonl", main);

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main], {
    HOME: home,
    PI_CODING_AGENT_SESSION_DIR: sessionRoot,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).sessions[0].records, [
    { line: 4, kind: "user", text: "OMP skill prompt marker\nSkill command instructions" },
    { line: 5, kind: "assistant", text: "OMP skill answer" },
  ]);
});

test("OMP rejects userless sessions with unrelated custom messages", (t) => {
  const home = workspace(t);
  const sessionRoot = join(home, ".omp/agent/sessions");
  const main = join(sessionRoot, "-workspace-project/session.jsonl");
  mkdirSync(dirname(main), { recursive: true });
  writeFileSync(main, [
    { type: "session", version: 3, id: "omp-userless-session", cwd: "/workspace/project" },
    { type: "custom_message", id: "custom1", parentId: null, customType: "notification", content: "OMP unrelated custom message" },
    { type: "message", id: "a1", parentId: "custom1", message: { role: "assistant", content: [{ type: "text", text: "OMP userless answer" }] } },
    { type: "model_usage", id: "usage1", parentId: "a1", activeLeafId: "a1", purpose: "late", api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main], {
    HOME: home,
    PI_CODING_AGENT_SESSION_DIR: sessionRoot,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported OMP transcript schema/);
  assert.equal(result.stdout, "");
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

test("OMP verifies workspace metadata for explicit transcripts outside discovery roots", (t) => {
  const home = workspace(t);
  const main = join(home, "exported/session.jsonl");
  copy("omp-main.jsonl", main);

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main], { HOME: home });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sessions[0].path, realpathSync(main));
  assert.deepEqual(texts(output), [
    "OMP verified user marker",
    "OMP main answer",
    "OMP failed tool",
    "OMP compacted evidence",
    "OMP final answer",
  ]);

  const mismatch = run(["--host", "omp", "--cwd", "/workspace/other", "--session", main], { HOME: home });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /mismatched OMP transcript/);
  assert.equal(mismatch.stdout, "");
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

test("OMP reports children whose parent branch association cannot be proven", (t) => {
  const home = workspace(t);
  const main = join(home, "session.jsonl");
  copy("omp-main.jsonl", main);
  copy("omp-child.jsonl", join(home, "session/child.jsonl"));
  const unknown = join(home, "session/unknown.jsonl");
  copy("omp-child.jsonl", unknown);

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sessions.length, 2);
  assert.equal(output.gaps.length, 1);
  assert.ok(output.gaps[0].includes(realpathSync(unknown)));
  assert.match(output.gaps[0], /association.*not established/);
});

test("OMP recursively follows active child task results, including async progress", (t) => {
  const home = workspace(t);
  const main = join(home, "session.jsonl");
  copy("omp-main.jsonl", main);
  const child = join(home, "session/child.jsonl");
  mkdirSync(dirname(child), { recursive: true });
  writeFileSync(child, [
    { type: "session", id: "child", cwd: "/workspace/project", parentSession: main },
    { type: "message", id: "a", parentId: null, message: { role: "assistant", content: [
      { type: "text", text: "Active child" },
      { type: "toolCall", id: "call", name: "task", arguments: {} },
    ] } },
    { type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: "call", toolName: "task", content: [], details: { progress: [{ id: "child.active" }] } } },
    { type: "message", id: "old", parentId: "a", message: { role: "assistant", content: [{ type: "toolCall", id: "old-call", name: "task", arguments: {} }] } },
    { type: "message", id: "old-r", parentId: "old", message: { role: "toolResult", toolCallId: "old-call", toolName: "task", content: [], details: { results: [{ id: "child.abandoned" }] } } },
    { type: "model_usage", id: "usage", parentId: "old-r", activeLeafId: "r" },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  copy("omp-child.jsonl", join(home, "session/child.active.jsonl"));
  copy("omp-child.jsonl", join(home, "session/child.abandoned.jsonl"));

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.sessions.map(({ path }) => path), [realpathSync(main), realpathSync(child), realpathSync(join(home, "session/child.active.jsonl"))]);
  assert.deepEqual(output.gaps, []);
});

test("OMP retains a deeply nested child chain without following directory symlinks or cycles", (t) => {
  const home = workspace(t);
  const main = join(home, "session.jsonl");
  copy("omp-main.jsonl", main);
  let directory = join(home, "session");
  const expected = [realpathSync(main)];
  for (let index = 0; index < 6; index++) {
    const name = index === 0 ? "child" : `nested${index}`;
    const child = join(directory, `${name}.jsonl`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(child, [
      { type: "session", id: name, cwd: "/workspace/project" },
      { type: "message", id: "a", parentId: null, message: { role: "assistant", content: [
        { type: "text", text: `Nested evidence ${index}` },
        { type: "toolCall", id: "call", name: "task", arguments: {} },
      ] } },
      { type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: "call", content: [],
        details: { results: [{ id: index === 5 ? "child" : `nested${index + 1}` }] } } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    expected.push(realpathSync(child));
    directory = join(directory, name);
  }
  copy("omp-child.jsonl", join(home, "outside/unknown.jsonl"));
  symlinkSync(join(home, "outside"), join(home, "session/escape"));

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.sessions.map(({ path }) => path), expected);
  assert.deepEqual(texts(output).filter((text) => text.startsWith("Nested evidence")), [
    "Nested evidence 0", "Nested evidence 1", "Nested evidence 2",
    "Nested evidence 3", "Nested evidence 4", "Nested evidence 5",
  ]);
  assert.deepEqual(output.gaps, []);
});

test("OMP preserves active evidence with unrelated and abandoned dangling child symlinks", (t) => {
  const home = workspace(t);
  const main = join(home, "session.jsonl");
  copy("omp-main.jsonl", main);
  copy("omp-child.jsonl", join(home, "session/child.jsonl"));
  for (const name of ["unknown", "abandoned"]) {
    symlinkSync(join(home, `session/${name}.missing`), join(home, `session/${name}.jsonl`));
  }

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.sessions.map(({ path }) => path), [realpathSync(main), realpathSync(join(home, "session/child.jsonl"))]);
  assert.ok(texts(output).includes("OMP final answer"));
  assert.ok(texts(output).includes("OMP child answer"));
  assert.equal(output.gaps.length, 2);
  for (const name of ["unknown", "abandoned"]) {
    assert.ok(output.gaps.some((gap) => gap.includes(`/${name}.jsonl`) && gap.includes("ENOENT")));
  }
});

for (const previouslyExcluded of [false, true]) {
  test(`OMP rejects a dangling active child${previouslyExcluded ? " previously reached through an abandoned branch" : ""}`, (t) => {
    const home = workspace(t);
    const main = join(home, "session.jsonl");
    copy("omp-main.jsonl", main);
    mkdirSync(join(home, "session"));
    symlinkSync(join(home, "session/missing.data"), join(home, "session/child.jsonl"));
    if (previouslyExcluded) copy("omp-main.jsonl", join(home, "session/abandoned.jsonl"));

    const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main]);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ENOENT/);
    assert.ok(result.stderr.includes("/session/child.jsonl"));
  });
}

test("OMP rejects child transcript symlinks escaping the verified artifact directory", (t) => {
  const home = workspace(t);
  const main = join(home, "session.jsonl");
  copy("omp-main.jsonl", main);
  const outside = join(home, "outside.jsonl");
  copy("omp-child.jsonl", outside);
  mkdirSync(join(home, "session"));
  symlinkSync(outside, join(home, "session/child.jsonl"));

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the verified OMP child root/);
  assert.equal(result.stdout, "");
});

test("OMP retains a proven child through a contained canonical symlink", (t) => {
  const home = workspace(t);
  const main = join(home, "session.jsonl");
  copy("omp-main.jsonl", main);
  const stored = join(home, "session/stored.data");
  copy("omp-child.jsonl", stored);
  symlinkSync(stored, join(home, "session/child.jsonl"));

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sessions[1].path, realpathSync(stored));
  assert.deepEqual(output.gaps, []);
});

for (const childId of ["missing", "../outside", "ambiguous"]) {
  test(`OMP reports an unresolved ${childId} task transcript without including alternatives`, (t) => {
    const home = workspace(t);
    const main = join(home, "session.jsonl");
    const child = join(home, "session/child.jsonl");
    copy("omp-main.jsonl", main);
    mkdirSync(dirname(child), { recursive: true });
    writeFileSync(child, [
      { type: "session", id: "child", cwd: "/workspace/project" },
      { type: "message", id: "a", parentId: null, message: { role: "assistant", content: [
        { type: "text", text: "Child answer" },
        { type: "toolCall", id: "call", name: "task", arguments: {} },
      ] } },
      { type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: "call", content: [], details: { results: [{ id: childId }] } } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    if (childId === "ambiguous") {
      copy("omp-child.jsonl", join(home, "session/ambiguous.jsonl"));
      copy("omp-child.jsonl", join(home, "session/child/ambiguous.jsonl"));
    } else {
      copy("omp-child.jsonl", join(home, "outside.jsonl"));
    }

    const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main]);

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sessions.length, 2);
    assert.ok(output.gaps.some((gap) => gap.includes(childId) && /association.*not established/.test(gap)));
    assert.equal(texts(output).includes("OMP child answer"), false);
  });
}

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

for (const [host, rootPath, envKey] of [
  ["claude", ".claude/projects", "CLAUDE_CONFIG_DIR"],
  ["codex", ".codex/sessions", "CODEX_HOME"],
  ["cursor", ".cursor/projects/workspace-project/agent-transcripts", null],
  ["omp", ".omp/agent/sessions", "PI_CODING_AGENT_SESSION_DIR"],
]) {
  for (const location of ["ordinary", "contained", "outside"]) {
    test(`${host} ID lookup ${location === "outside" ? "rejects an escaping symlink" : `accepts an ${location} transcript`}`, (t) => {
      const home = workspace(t);
      const root = join(home, rootPath);
      const id = `${host}-session`;
      const selected = host === "cursor" ? join(root, id, `${id}.jsonl`) : join(root, `${id}.jsonl`);
      const target = location === "ordinary" ? selected
        : join(location === "contained" ? root : home, "stored.jsonl");
      copy(`${host}-main.jsonl`, target);
      if (location !== "ordinary") {
        mkdirSync(dirname(selected), { recursive: true });
        symlinkSync(target, selected);
      }
      const env = { HOME: home };
      if (envKey) env[envKey] = host === "omp" ? root : dirname(root);

      const result = run(["--host", host, "--cwd", "/workspace/project", "--session", id], env);

      if (location === "outside") {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /cannot identify requested .* session/);
        assert.equal(result.stdout, "");
      } else {
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.sessions[0].path, realpathSync(target));
      }
    });
  }
}

for (const [host, metadata, message, envKey] of [
  ["claude", { sessionId: "resumed-session", cwd: "/workspace/project", type: "user" }, { message: { role: "user", content: "Resumed Claude evidence" } }, "CLAUDE_CONFIG_DIR"],
  ["codex", { type: "session_meta", payload: { id: "resumed-session", cwd: "/workspace/project" } }, { type: "response_item", payload: { type: "message", role: "user", content: "Resumed Codex evidence" } }, "CODEX_HOME"],
  ["omp", { type: "session", id: "resumed-session", cwd: "/workspace/project" }, { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Resumed OMP evidence" } }, "PI_CODING_AGENT_SESSION_DIR"],
]) {
  test(`${host} resolves a resumed session ID from metadata when its filename differs`, (t) => {
    const home = workspace(t);
    const root = join(home, "sessions");
    const directory = host === "claude" ? join(root, "projects") : host === "codex" ? join(root, "sessions") : root;
    mkdirSync(directory, { recursive: true });
    const session = join(directory, "original-filename.jsonl");
    const records = host === "claude" ? [{ ...metadata, ...message }] : [metadata, message];
    writeFileSync(session, records.map((record) => JSON.stringify(record)).join("\n"));
    writeFileSync(join(directory, "unrelated.jsonl"), "{not json}\n");
    symlinkSync(join(directory, "missing.jsonl"), join(directory, "dangling.jsonl"));
    const otherWorkspace = structuredClone(records);
    if (host === "codex") otherWorkspace[0].payload.cwd = "/workspace/other";
    else otherWorkspace[0].cwd = "/workspace/other";
    writeFileSync(join(directory, "other-workspace.jsonl"), otherWorkspace.map((record) => JSON.stringify(record)).join("\n"));
    if (host === "claude") {
      const child = join(directory, "original-filename", "subagents", "child.jsonl");
      mkdirSync(dirname(child), { recursive: true });
      writeFileSync(child, JSON.stringify({ ...metadata, isSidechain: true, message: { role: "assistant", content: "Resumed Claude child" } }));
    }

    const result = run(["--host", host, "--cwd", "/workspace/project", "--session", "resumed-session"], {
      HOME: home,
      [envKey]: root,
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sessions[0].path, realpathSync(session));
    assert.deepEqual(texts(output), host === "claude"
      ? ["Resumed Claude evidence", "Resumed Claude child"]
      : [host === "omp" ? "Resumed OMP evidence" : "Resumed Codex evidence"]);
  });

  test(`${host} stops unrelated metadata lookup before a large malformed tail`, (t) => {
    const home = workspace(t);
    const root = join(home, "sessions");
    const directory = host === "claude" ? join(root, "projects") : host === "codex" ? join(root, "sessions") : root;
    mkdirSync(directory, { recursive: true });
    const session = join(directory, "original-filename.jsonl");
    const records = host === "claude" ? [{ ...metadata, ...message }] : [metadata, message];
    const prefix = `${JSON.stringify({ padding: "é".repeat(40000) })}\r\n\r\n`;
    writeFileSync(session, prefix + records.map((record) => JSON.stringify(record)).join("\n"));
    const unrelated = join(directory, "resumed-session.jsonl");
    for (const mismatch of ["identity", "workspace", ...(host === "claude" ? ["sidechain"] : [])]) {
      const header = structuredClone(metadata);
      const identity = host === "codex" ? header.payload : header;
      if (mismatch === "identity") identity[host === "claude" ? "sessionId" : "id"] = "another-session";
      else if (mismatch === "workspace") identity.cwd = "/workspace/other";
      else identity.isSidechain = true;
      writeFileSync(unrelated, `${JSON.stringify(header)}\n{${"malformed tail ".repeat(100000)}`);

      const result = run(["--host", host, "--cwd", "/workspace/project", "--session", "resumed-session"], {
        HOME: home,
        [envKey]: root,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).sessions[0].path, realpathSync(session));
    }
  });

  test(`${host} rejects duplicate metadata identities even with a malformed tail`, (t) => {
    const home = workspace(t);
    const root = join(home, "sessions");
    const directory = host === "claude" ? join(root, "projects") : host === "codex" ? join(root, "sessions") : root;
    mkdirSync(directory, { recursive: true });
    const records = host === "claude" ? [{ ...metadata, ...message }] : [metadata, message];
    writeFileSync(join(directory, "original.jsonl"), records.map((record) => JSON.stringify(record)).join("\n"));
    writeFileSync(join(directory, "duplicate.jsonl"), `${JSON.stringify(metadata)}\n{malformed tail}`);

    const result = run(["--host", host, "--cwd", "/workspace/project", "--session", "resumed-session"], {
      HOME: home,
      [envKey]: root,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot identify requested .* session/);
    assert.equal(result.stdout, "");
  });

  test(`${host} fully validates selected transcripts after metadata lookup`, (t) => {
    const home = workspace(t);
    const root = join(home, "sessions");
    const directory = host === "claude" ? join(root, "projects") : host === "codex" ? join(root, "sessions") : root;
    mkdirSync(directory, { recursive: true });
    const session = join(directory, "original-filename.jsonl");
    const records = host === "claude" ? [{ ...metadata, ...message }] : [metadata, message];
    writeFileSync(session, `${records.map((record) => JSON.stringify(record)).join("\n")}\n{malformed tail}`);
    for (const request of ["resumed-session", session]) {
      const result = run(["--host", host, "--cwd", "/workspace/project", "--session", request], {
        HOME: home,
        [envKey]: root,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`malformed JSONL at .*:${records.length + 1}`));
      assert.equal(result.stdout, "");
    }
  });
}

test("metadata lookup rejects duplicate session identities", (t) => {
  const home = workspace(t);
  const root = join(home, "sessions");
  mkdirSync(root);
  const header = JSON.stringify({ type: "session", id: "resumed-session", cwd: "/workspace/project" });
  writeFileSync(join(root, "first.jsonl"), header);
  writeFileSync(join(root, "second.jsonl"), header);

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", "resumed-session"], {
    HOME: home,
    PI_CODING_AGENT_SESSION_DIR: root,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot identify requested omp session/);
});

test("metadata lookup rejects symlinks outside verified session roots", (t) => {
  const home = workspace(t);
  const root = join(home, ".omp/agent/sessions");
  mkdirSync(root, { recursive: true });
  const outside = join(home, "outside.jsonl");
  writeFileSync(outside, [
    { type: "session", id: "resumed-session", cwd: "/workspace/project" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Outside evidence" } },
  ].map((record) => JSON.stringify(record)).join("\n"));
  symlinkSync(outside, join(root, "link.jsonl"));

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", "resumed-session"], {
    HOME: home,
    PI_CODING_AGENT_SESSION_DIR: root,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot identify requested omp session/);
});

for (const host of ["claude", "codex", "omp"]) {
  test(`${host} verifies requested identity rather than a filename substring`, (t) => {
    const home = workspace(t);
    const root = join(home, "sessions");
    const directory = host === "claude" ? join(root, "projects") : host === "codex" ? join(root, "sessions") : root;
    mkdirSync(directory, { recursive: true });
    const records = (id) => host === "claude"
      ? [{ type: "user", sessionId: id, cwd: "/workspace/project", message: { role: "user", content: "Verified identity" } }]
      : host === "codex"
        ? [{ type: "session_meta", payload: { id, cwd: "/workspace/project" } },
          { type: "response_item", payload: { type: "message", role: "user", content: "Verified identity" } }]
        : [{ type: "session", id, cwd: "/workspace/project" },
          { type: "message", id: "u", parentId: null, message: { role: "user", content: "Verified identity" } }];
    const env = { HOME: home, [host === "claude" ? "CLAUDE_CONFIG_DIR" : host === "codex" ? "CODEX_HOME" : "PI_CODING_AGENT_SESSION_DIR"]: root };
    const args = ["--host", host, "--cwd", "/workspace/project", "--session", "wanted"];
    for (const filename of ["backup-wanted.jsonl", "wanted.jsonl"]) {
      const path = join(directory, filename);
      writeFileSync(path, records("other").map((record) => JSON.stringify(record)).join("\n"));
      const rejected = run(args, env);
      assert.notEqual(rejected.status, 0);
      assert.equal(rejected.stdout, "");
    }
    const verified = join(directory, "resumed.jsonl");
    writeFileSync(verified, records("wanted").map((record) => JSON.stringify(record)).join("\n"));
    const accepted = run(args, env);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).sessions[0].path, realpathSync(verified));
    assert.deepEqual(texts(JSON.parse(accepted.stdout)), ["Verified identity"]);

    writeFileSync(join(directory, "wanted.jsonl"), records("wanted").map((record) => JSON.stringify(record)).join("\n"));
    const ambiguous = run(args, env);
    assert.notEqual(ambiguous.status, 0);
    assert.equal(ambiguous.stdout, "");
  });
}

for (const host of ["claude", "codex"]) {
  test(`${host} verifies exported log host and workspace without expanding ID discovery`, (t) => {
    const home = workspace(t);
    const exported = join(home, "exported", "session.jsonl");
    copy(`${host}-main.jsonl`, exported);
    const args = ["--host", host, "--cwd", "/workspace/project", "--session", exported];
    const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") };
    const accepted = run(args, env);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).sessions[0].path, realpathSync(exported));
    assert.ok(texts(JSON.parse(accepted.stdout)).includes(host === "claude" ? "Claude user marker" : "Codex user marker"));

    copy(`${host}-other.jsonl`, exported);
    const mismatch = run(args, env);
    assert.notEqual(mismatch.status, 0);
    assert.equal(mismatch.stdout, "");
    copy(`${host === "claude" ? "codex" : "claude"}-main.jsonl`, exported);
    const wrongHost = run(args, env);
    assert.notEqual(wrongHost.status, 0);
    assert.equal(wrongHost.stdout, "");
    copy(`${host}-main.jsonl`, exported);
    const undiscovered = run(["--host", host, "--cwd", "/workspace/project", "--session", "session"], env);
    assert.notEqual(undiscovered.status, 0);
    assert.equal(undiscovered.stdout, "");
  });
}

for (const [host, kind] of [["claude", "subagents"], ["cursor", "subagents"], ["cursor", "compaction"]]) {
  for (const location of ["outside", "inside", "..legitimate"]) {
    const contained = location !== "outside";
    test(`${host} ${kind} ${contained ? `retain ${location}` : "reject escaping"} symlink evidence`, (t) => {
      const home = workspace(t);
      const directory = host === "claude"
        ? join(home, ".claude/projects/workspace")
        : join(home, ".cursor/projects/workspace-project/agent-transcripts/session");
      const main = join(directory, "session.jsonl");
      copy(`${host}-main.jsonl`, main);
      const boundary = host === "claude" ? join(directory, "session") : directory;
      const child = join(boundary, kind, kind === "compaction" ? "summary.md" : "child.jsonl");
      const stored = join(contained ? boundary : home, location === "..legitimate" ? "..legitimate/stored.data" : "stored.data");
      copy(kind === "compaction" ? "cursor-compaction.md" : `${host === "claude" ? "claude-main" : "cursor-subagent"}.jsonl`, stored);
      mkdirSync(dirname(child), { recursive: true });
      symlinkSync(stored, child);

      const result = run(["--host", host, "--cwd", "/workspace/project", "--session", main], { HOME: home });
      if (contained) {
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.sessions.length, 2);
        assert.equal(output.sessions[1].path, realpathSync(stored));
        assert.ok(output.sessions[1].records.length > 0);
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
      }
    });
  }
}

test("OMP preserves active evidence when unrelated and abandoned children are malformed", (t) => {
  const home = workspace(t);
  const main = join(home, "session.jsonl");
  copy("omp-main.jsonl", main);
  copy("omp-child.jsonl", join(home, "session/child.jsonl"));
  for (const name of ["unknown", "abandoned"]) writeFileSync(join(home, `session/${name}.jsonl`), "{not json}\n");

  const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main], { HOME: home });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.sessions.map(({ path }) => path), [realpathSync(main), realpathSync(join(home, "session/child.jsonl"))]);
  assert.ok(texts(output).includes("OMP final answer"));
  assert.ok(texts(output).includes("OMP child answer"));
  assert.equal(output.gaps.length, 2);
  for (const name of ["unknown", "abandoned"]) assert.ok(output.gaps.some((gap) => gap.includes(realpathSync(join(home, `session/${name}.jsonl`)))));
});

for (const required of ["main", "active child", "previously excluded child"]) {
  test(`OMP fails closed for a malformed ${required}`, (t) => {
    const home = workspace(t);
    const main = join(home, "session.jsonl");
    copy("omp-main.jsonl", main);
    const child = join(home, "session/child.jsonl");
    copy("omp-child.jsonl", child);
    writeFileSync(required === "main" ? main : child, "{not json}\n");
    if (required === "previously excluded child") symlinkSync(child, join(home, "session/abandoned.jsonl"));

    const result = run(["--host", "omp", "--cwd", "/workspace/project", "--session", main], { HOME: home });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(required === "main" ? realpathSync(main) : realpathSync(child)));
  });
}
