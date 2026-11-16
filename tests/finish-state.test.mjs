import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../skills/orchestrate/scripts/finish-state.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const mode = (file) => statSync(file).mode & 0o777;

function stateFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "finish-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "run", "finish.json");
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

function fails(result, code, locations) {
  assert.equal(result.status, code, result.stderr);
  assert.equal(result.stdout, "");
  const lines = result.stderr.trimEnd().split("\n");
  assert.equal(lines.length, locations.length, result.stderr);
  locations.forEach((location, index) => assert.ok(lines[index].startsWith(`${location}:`), result.stderr));
}

function create(t) {
  const file = stateFile(t);
  succeeds(run("create", file, "--repository", dirname(file), "--run-key", "run-1", "--coordinator", "c1"));
  return file;
}

test("create writes a valid private record and refuses an existing file unchanged", (t) => {
  const file = create(t);
  assert.ok(existsSync(file), "create must persist the record");
  succeeds(run("check", file));
  assert.deepEqual(read(file), { state_version: 1, repository: dirname(file), run_key: "run-1", coordinator: { block: "c1" }, lanes: {} });
  assert.equal(mode(dirname(file)), 0o700);
  assert.equal(mode(file), 0o600);
  const before = readFileSync(file);
  const result = run("create", file, "--repository", dirname(file), "--run-key", "another-run", "--coordinator", "c1");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr.trimEnd().split("\n").length, 1);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(dirname(file)), ["finish.json"]);
});

function record() {
  return {
    state_version: 1, repository: "/project", run_key: "run-1", coordinator: { block: "c1" },
    lanes: { "1": { issue: "126", branch: "fix/state", pane: "p2", panes: ["p1", "p2"], status: "working", extra: { keep: [1, null] } } },
    jobs: [{ id: "job-1" }], evidence: { paths: ["result.json"] },
    wait: { resource: "build slot", since: "2026-01-01T00:00:00Z", extra: { owner: "another-run" } },
  };
}

function seed(t, state = record()) {
  const file = create(t);
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  return file;
}

test("check accepts extra root, lane and wait keys and every lane status", (t) => {
  const state = record();
  state.lanes["2"] = { issue: null, branch: null, pane: "p3", panes: ["p3"], status: "idle" };
  state.lanes["3"] = { issue: "notes/issue.md", branch: null, pane: "p4", panes: ["p4"], status: "parked", park_reason: "Needs input" };
  state.lanes["4"] = { issue: "127", branch: null, pane: "p5", panes: ["p5"], status: "interrupted", park_reason: null };
  succeeds(run("check", seed(t, state)));
});

for (const issue of ["x", "0126", "0", "/notes/issue.md", "../issue.md", "..", "notes/../issue.md", "notes/./issue.md", "notes//issue.md", "notes\\issue.md", "notes/issue.txt"]) {
  test(`issue rejects invalid key ${JSON.stringify(issue)} in check and lane`, (t) => {
    const state = record();
    state.lanes["1"].issue = issue;
    const invalid = seed(t, state);
    const invalidBefore = readFileSync(invalid);
    const checked = run("check", invalid);
    fails(checked, 1, ["lanes.1.issue"]);
    assert.equal(checked.stderr, "lanes.1.issue: must be a decimal issue number or a repository-relative Markdown path\n");
    assert.deepEqual(readFileSync(invalid), invalidBefore);
    const file = seed(t);
    const before = readFileSync(file);
    const written = run("lane", file, "1", "--issue", issue);
    fails(written, 1, ["lanes.1.issue"]);
    assert.equal(written.stderr, checked.stderr);
    assert.deepEqual(readFileSync(file), before);
  });
}

for (const issue of ["126", "issue.md", "notes/issue.md", "notes/my issue.md"]) {
  test(`lane accepts issue key ${JSON.stringify(issue)}`, (t) => {
    const file = seed(t);
    succeeds(run("lane", file, "1", "--issue", issue));
    assert.equal(read(file).lanes["1"].issue, issue);
    succeeds(run("check", file));
  });
}

const invalidRecords = [
  ["array lanes", (s) => { s.lanes = []; }, "lanes"],
  ["non-decimal lane key", (s) => { s.lanes.x = s.lanes["1"]; delete s.lanes["1"]; }, "lanes.x"],
  ["zero-padded lane key", (s) => { s.lanes["01"] = s.lanes["1"]; delete s.lanes["1"]; }, "lanes.01"],
  ["missing issue", (s) => { delete s.lanes["1"].issue; }, "lanes.1.issue"],
  ["non-string issue", (s) => { s.lanes["1"].issue = 126; }, "lanes.1.issue"],
  ["missing branch", (s) => { delete s.lanes["1"].branch; }, "lanes.1.branch"],
  ["non-string branch", (s) => { s.lanes["1"].branch = false; }, "lanes.1.branch"],
  ["pane differs from last pane", (s) => { s.lanes["1"].pane = "p1"; }, "lanes.1.pane"],
  ["duplicate panes", (s) => { s.lanes["1"].panes = ["p1", "p1", "p2"]; }, "lanes.1.panes"],
  ["unknown status", (s) => { s.lanes["1"].status = "finished"; }, "lanes.1.status"],
  ["parked without reason", (s) => { s.lanes["1"].status = "parked"; }, "lanes.1.park_reason"],
  ["reason on working lane", (s) => { s.lanes["1"].park_reason = "stale"; }, "lanes.1.park_reason"],
  ["idle with issue", (s) => { s.lanes["1"].status = "idle"; s.lanes["1"].branch = null; }, "lanes.1.issue"],
  ["idle with branch", (s) => { s.lanes["1"].status = "idle"; s.lanes["1"].issue = null; }, "lanes.1.branch"],
  ["empty wait resource", (s) => { s.wait.resource = ""; }, "wait.resource"],
  ["since without seconds", (s) => { s.wait.since = "2026-01-01T00:00Z"; }, "wait.since"],
  ["since without offset", (s) => { s.wait.since = "2026-01-01T00:00:00"; }, "wait.since"],
  ["invalid calendar instant", (s) => { s.wait.since = "2026-02-30T10:00:00Z"; }, "wait.since"],
  ["missing state_version is legacy", (s) => { delete s.state_version; s.lanes = []; }, "state_version", /legacy/],
];

for (const [name, change, location, message] of invalidRecords) {
  test(`check rejects ${name} with one located violation`, (t) => {
    const state = record();
    change(state);
    const result = run("check", seed(t, state));
    fails(result, 1, [location]);
    if (message) assert.match(result.stderr, message);
  });
}

test("check reports all independent violations on separate located lines", (t) => {
  const state = record();
  state.repository = "";
  state.run_key = "";
  fails(run("check", seed(t, state)), 1, ["repository", "run_key"]);
});

for (const [name, args] of [
  ["unknown command", ["unknown"]],
  ["missing command", []],
  ["missing file", ["check"]],
  ["extra positional", ["check", "FILE", "extra"]],
  ["unknown option", ["check", "FILE", "--unknown"]],
  ["option from another command", ["check", "FILE", "--repository", "/project"]],
  ["missing required option", ["create", "FILE", "--repository", "/project", "--coordinator", "c1"]],
  ["bad lane number", ["lane", "FILE", "01"]],
  ["create missing repository", ["create", "FILE", "--run-key", "run-1", "--coordinator", "c1"]],
  ["coordinator missing file", ["coordinator"]],
  ["coordinator extra positional", ["coordinator", "FILE", "c2", "extra"]],
  ["coordinator unknown option", ["coordinator", "FILE", "c2", "--pane", "p3"]],
]) {
  test(`usage error exits 2: ${name}`, (t) => {
    const file = stateFile(t);
    const result = run(...args.map((arg) => arg === "FILE" ? file : arg));
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stderr.trimEnd().split("\n").length, 1);
    assert.notEqual(result.stderr.trim(), "");
    assert.equal(result.stdout, "");
    assert.equal(existsSync(file), false);
  });
}

test("check exits 2 for a missing file", (t) => {
  const result = run("check", stateFile(t));
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr.trimEnd().split("\n").length, 1);
  assert.match(result.stderr, /ENOENT|read|file/i);
});

test("check exits 2 for invalid JSON", (t) => {
  const file = create(t);
  writeFileSync(file, "{ invalid\njson");
  const result = run("check", file);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr.trimEnd().split("\n").length, 1);
  assert.match(result.stderr, /JSON|parse|property/i);
});

for (const [name, option, location] of [["repository", "--repository", "repository"], ["run key", "--run-key", "run_key"], ["coordinator", "--coordinator", "coordinator.block"]]) {
  test(`create rejects an empty ${name} without creating a file`, (t) => {
    const file = stateFile(t);
    const args = ["create", file, "--repository", dirname(file), "--run-key", "run-1", "--coordinator", "c1"];
    args[args.indexOf(option) + 1] = "";
    fails(run(...args), 1, [location]);
    assert.equal(existsSync(file), false);
  });
}

test("repository must be an absolute path for create and check", (t) => {
  const file = stateFile(t);
  const result = run("create", file, "--repository", "project", "--run-key", "run-1", "--coordinator", "c1");
  fails(result, 1, ["repository"]);
  assert.equal(result.stderr, "repository: must be a canonical absolute path\n");
  assert.equal(existsSync(file), false);
  const state = record();
  state.repository = "project";
  const existing = seed(t, state);
  const before = readFileSync(existing);
  const checked = run("check", existing);
  fails(checked, 1, ["repository"]);
  assert.equal(checked.stderr, "repository: must be a canonical absolute path\n");
  assert.deepEqual(readFileSync(existing), before);
});

for (const repository of ["/project/../other", "/project/./repo", "/project//repo", "/project/"]) {
  test(`repository rejects non-canonical path ${repository}`, (t) => {
    const file = stateFile(t);
    const result = run("create", file, "--repository", repository, "--run-key", "run-1", "--coordinator", "c1");
    fails(result, 1, ["repository"]);
    assert.equal(result.stderr, "repository: must be a canonical absolute path\n");
    assert.equal(existsSync(file), false);
    const state = record();
    state.repository = repository;
    const existing = seed(t, state);
    const before = readFileSync(existing);
    const checked = run("check", existing);
    fails(checked, 1, ["repository"]);
    assert.equal(checked.stderr, "repository: must be a canonical absolute path\n");
    assert.deepEqual(readFileSync(existing), before);
  });
}

for (const repository of ["/", "/project name/repo"]) {
  test(`create accepts canonical repository ${repository}`, (t) => {
    const file = stateFile(t);
    succeeds(run("create", file, "--repository", repository, "--run-key", "run-1", "--coordinator", "c1"));
    assert.equal(read(file).repository, repository);
    succeeds(run("check", file));
  });
}

test("create keeps existing directory modes while making new levels private under a restrictive umask", (t) => {
  const existing = dirname(dirname(stateFile(t)));
  chmodSync(existing, 0o751);
  const file = join(existing, "finish.json");
  const previous = process.umask(0o777);
  try {
    succeeds(spawnSync(process.execPath, [script, "create", "finish.json", "--repository", "/project", "--run-key", "run-1", "--coordinator", "c1"], { cwd: existing, encoding: "utf8" }));
    const nested = join(existing, "one", "two", "finish.json");
    succeeds(run("create", nested, "--repository", "/project", "--run-key", "run-2", "--coordinator", "c2"));
    assert.equal(mode(dirname(nested)), 0o700);
    assert.equal(mode(dirname(dirname(nested))), 0o700);
    assert.equal(mode(nested), 0o600);
  } finally {
    process.umask(previous);
  }
  assert.equal(mode(existing), 0o751);
  assert.equal(mode(file), 0o600);
  succeeds(run("check", file));
});

test("create refuses a non-directory parent without changing its file mode", (t) => {
  const file = stateFile(t);
  const parent = dirname(file);
  writeFileSync(parent, "keep this file", { mode: 0o644 });
  chmodSync(parent, 0o644);
  const result = run("create", file, "--repository", "/project", "--run-key", "run-1", "--coordinator", "c1");
  assert.equal(result.status, 2, result.stderr);
  assert.equal(mode(parent), 0o644);
  assert.equal(readFileSync(parent, "utf8"), "keep this file");
  assert.equal(existsSync(file), false);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trimEnd().split("\n").length, 1);
  assert.ok(result.stderr.includes(parent), result.stderr);
  assert.match(result.stderr, /not a directory/);
});

function preserved(file, before) {
  const after = read(file);
  assert.deepEqual(after.jobs, before.jobs);
  assert.deepEqual(after.evidence, before.evidence);
  assert.deepEqual(after.lanes["1"].extra, before.lanes["1"].extra);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(Object.keys(after.lanes["1"]), Object.keys(before.lanes["1"]));
  assert.equal(mode(file), 0o600);
  succeeds(run("check", file));
  assert.deepEqual(readdirSync(dirname(file)), ["finish.json"]);
}

test("lane write updates the minimum while preserving extras, key order and private mode", (t) => {
  const before = record();
  const file = seed(t, before);
  chmodSync(file, 0o644);
  succeeds(run("lane", file, "1", "--branch", "fix/new-branch"));
  assert.equal(read(file).lanes["1"].branch, "fix/new-branch");
  assert.deepEqual(read(file).wait, before.wait);
  preserved(file, before);
});

test("new lane records minimum keys in order before its first worker", (t) => {
  const file = create(t);
  succeeds(run("lane", file, "2", "--pane", "p1", "--status", "idle"));
  assert.deepEqual(read(file).lanes["2"], { issue: null, branch: null, pane: "p1", panes: ["p1"], status: "idle" });
  assert.deepEqual(Object.keys(read(file).lanes["2"]), ["issue", "branch", "pane", "panes", "status"]);
  succeeds(run("check", file));
});

test("pane replacement on a working lane preserves its fields and extras and appends ownership", (t) => {
  const before = record();
  const file = seed(t, before);
  chmodSync(file, 0o644);
  succeeds(run("lane", file, "1", "--pane", "p3"));
  assert.deepEqual(read(file), {
    ...before,
    lanes: { "1": { ...before.lanes["1"], pane: "p3", panes: ["p1", "p2", "p3"] } },
  });
  preserved(file, before);
  succeeds(run("lane", file, "1", "--pane", "p3"));
  assert.deepEqual(read(file).lanes["1"].panes, ["p1", "p2", "p3"]);
});

for (const [name, args, locations] of [
  ["parked without reason", ["1", "--status", "parked"], ["lanes.1.park_reason"]],
  ["idle with explicit issue", ["1", "--status", "idle", "--issue", "127"], ["lanes.1.issue"]],
  ["idle with explicit branch", ["1", "--status", "idle", "--branch", "fix/other"], ["lanes.1.branch"]],
  ["reason on non-parked lane", ["1", "--park-reason", "stale"], ["lanes.1.park_reason"]],
  ["reused non-current pane", ["1", "--pane", "p1"], ["lanes.1.panes"]],
  ["new lane without pane", ["2", "--status", "idle"], ["lanes.2.pane", "lanes.2.panes"]],
  ["new lane without status", ["2", "--pane", "p3"], ["lanes.2.status"]],
]) {
  test(`lane refuses ${name} and leaves bytes unchanged`, (t) => {
    const file = seed(t);
    const before = readFileSync(file);
    fails(run("lane", file, ...args), 1, locations);
    assert.deepEqual(readFileSync(file), before);
  });
}

test("changing issue without branch resets branch to null", (t) => {
  const file = seed(t);
  succeeds(run("lane", file, "1", "--issue", "127"));
  assert.equal(read(file).lanes["1"].issue, "127");
  assert.equal(read(file).lanes["1"].branch, null);
  succeeds(run("lane", file, "1", "--issue", "128", "--branch", "fix/128"));
  assert.equal(read(file).lanes["1"].branch, "fix/128");
  succeeds(run("lane", file, "1", "--issue", "128"));
  assert.equal(read(file).lanes["1"].branch, "fix/128");
});

test("idle clears issue and branch and leaving parked removes its reason", (t) => {
  const file = seed(t);
  succeeds(run("lane", file, "1", "--status", "parked", "--park-reason", "Needs input"));
  succeeds(run("lane", file, "1", "--status", "parked"));
  assert.equal(read(file).lanes["1"].park_reason, "Needs input");
  succeeds(run("lane", file, "1", "--status", "idle"));
  assert.equal(read(file).lanes["1"].issue, null);
  assert.equal(read(file).lanes["1"].branch, null);
  assert.equal(Object.hasOwn(read(file).lanes["1"], "park_reason"), false);
  succeeds(run("check", file));
});

for (const command of [["lane", "1", "--status", "idle"], ["wait-set", "build slot"], ["wait-clear"], ["coordinator", "c2"]]) {
  test(`${command[0]} refuses legacy records unchanged`, (t) => {
    const state = record();
    delete state.state_version;
    const file = seed(t, state);
    chmodSync(file, 0o640);
    const before = readFileSync(file);
    const result = run(command[0], file, ...command.slice(1));
    fails(result, 1, ["state_version"]);
    assert.match(result.stderr, /legacy.*not rewritten/);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(mode(file), 0o640);
  });
}

test("wait-set preserves since and every extra key for the same resource", (t) => {
  const before = record();
  const file = seed(t, before);
  chmodSync(file, 0o644);
  succeeds(run("wait-set", file, "build slot"));
  assert.deepEqual(read(file).wait, before.wait);
  preserved(file, before);
});

test("wait-set changes resource with a fresh UTC seconds stamp and preserves extras", (t) => {
  const before = record();
  const file = seed(t, before);
  const start = Math.floor(Date.now() / 1000) * 1000;
  succeeds(run("wait-set", file, "deployment slot"));
  const end = Date.now();
  const after = read(file);
  assert.equal(after.wait.resource, "deployment slot");
  assert.match(after.wait.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Date.parse(after.wait.since) >= start && Date.parse(after.wait.since) <= end);
  assert.notEqual(after.wait.since, before.wait.since);
  assert.deepEqual(after.wait.extra, before.wait.extra);
  preserved(file, before);
});

test("wait-clear sets wait to null and preserves other extras and private mode", (t) => {
  const before = record();
  const file = seed(t, before);
  chmodSync(file, 0o644);
  succeeds(run("wait-clear", file));
  assert.equal(read(file).wait, null);
  preserved(file, before);
});

for (const initial of [null, undefined]) {
  test(`wait commands handle ${initial === null ? "null" : "absent"} wait`, (t) => {
    const state = record();
    if (initial === undefined) delete state.wait;
    else state.wait = null;
    const file = seed(t, state);
    succeeds(run("check", file));
    succeeds(run("wait-clear", file));
    assert.equal(read(file).wait, null);
    succeeds(run("wait-set", file, "build slot"));
    assert.equal(read(file).wait.resource, "build slot");
    succeeds(run("check", file));
  });
}

test("wait-set rejects an empty resource without changing bytes", (t) => {
  const file = seed(t);
  const before = readFileSync(file);
  fails(run("wait-set", file, ""), 1, ["wait.resource"]);
  assert.deepEqual(readFileSync(file), before);
});

for (const [name, change, location] of [
  ["unsupported version", (s) => { s.state_version = 2; }, "state_version"],
  ["non-object lane", (s) => { s.lanes["1"] = null; }, "lanes.1"],
  ["empty issue", (s) => { s.lanes["1"].issue = ""; }, "lanes.1.issue"],
  ["empty branch", (s) => { s.lanes["1"].branch = ""; }, "lanes.1.branch"],
  ["working without issue", (s) => { s.lanes["1"].issue = null; }, "lanes.1.issue"],
  ["empty pane", (s) => { s.lanes["1"].pane = ""; }, "lanes.1.pane"],
  ["empty panes", (s) => { s.lanes["1"].panes = []; }, "lanes.1.panes"],
  ["non-string pane history", (s) => { s.lanes["1"].panes = [7, "p2"]; }, "lanes.1.panes"],
  ["non-object wait", (s) => { s.wait = []; }, "wait"],
  ["non-string since", (s) => { s.wait.since = 0; }, "wait.since"],
  ["non-leap February 29", (s) => { s.wait.since = "2026-02-29T10:00:00Z"; }, "wait.since"],
  ["hour 24", (s) => { s.wait.since = "2026-01-01T24:00:00Z"; }, "wait.since"],
  ["minute 60", (s) => { s.wait.since = "2026-01-01T10:60:00Z"; }, "wait.since"],
  ["second 60", (s) => { s.wait.since = "2026-01-01T10:00:60Z"; }, "wait.since"],
  ["offset hour 24", (s) => { s.wait.since = "2026-01-01T10:00:00+24:00"; }, "wait.since"],
  ["offset minute 60", (s) => { s.wait.since = "2026-01-01T10:00:00+01:60"; }, "wait.since"],
]) {
  test(`check rejects ${name} with its JSON location`, (t) => {
    const state = record();
    change(state);
    fails(run("check", seed(t, state)), 1, [location]);
  });
}

for (const root of [null, [], 1]) {
  test(`check rejects non-object root ${JSON.stringify(root)} once`, (t) => {
    fails(run("check", seed(t, root)), 1, ["root"]);
  });
}

for (const since of ["2024-02-29T23:59:59.123Z", "2000-02-29T10:00:00+23:59", "2026-01-01T00:00:00-05:30"]) {
  test(`check accepts calendar-valid timestamp ${since}`, (t) => {
    const state = record();
    state.wait.since = since;
    succeeds(run("check", seed(t, state)));
  });
}

for (const command of [["lane", "1", "--status", "idle"], ["wait-set", "build slot"], ["wait-clear"], ["coordinator", "c2"]]) {
  test(`${command[0]} validates the whole result before writing`, (t) => {
    const state = record();
    state.run_key = "";
    const file = seed(t, state);
    chmodSync(file, 0o640);
    const before = readFileSync(file);
    fails(run(command[0], file, ...command.slice(1)), 1, ["run_key"]);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(mode(file), 0o640);
    assert.deepEqual(readdirSync(dirname(file)), ["finish.json"]);
  });
}

for (const command of [["lane", "1", "--status", "idle"], ["wait-set", "build slot"], ["wait-clear"], ["coordinator", "c2"]]) {
  for (const invalidJSON of [false, true]) {
    test(`${command[0]} exits 2 for ${invalidJSON ? "invalid JSON" : "a missing file"}`, (t) => {
      const file = invalidJSON ? create(t) : stateFile(t);
      if (invalidJSON) writeFileSync(file, "{ invalid\njson");
      const before = invalidJSON ? readFileSync(file) : null;
      const result = run(command[0], file, ...command.slice(1));
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stderr.trimEnd().split("\n").length, 1);
      assert.notEqual(result.stderr.trim(), "");
      assert.equal(result.stdout, "");
      if (invalidJSON) assert.deepEqual(readFileSync(file), before);
      else assert.equal(existsSync(file), false);
    });
  }
}

test("check reports every out-of-range number at its nested location", (t) => {
  const state = record();
  state.evidence.value = "OVERFLOW";
  state.evidence.values = [0, "UNDERFLOW"];
  const file = seed(t, state);
  writeFileSync(file, readFileSync(file, "utf8").replace('"OVERFLOW"', "1e400").replace('"UNDERFLOW"', "-1e400"));
  const before = readFileSync(file);
  const result = run("check", file);
  fails(result, 1, ["evidence.value", "evidence.values.1"]);
  assert.equal(result.stderr, "evidence.value: number is out of range and cannot be preserved\nevidence.values.1: number is out of range and cannot be preserved\n");
  assert.deepEqual(readFileSync(file), before);
});

test("check and writers preserve a finite extra value nested 2000 levels deep", (t) => {
  const nested = '{"x":'.repeat(2000) + "42" + "}".repeat(2000);
  const state = record();
  state.extra = JSON.parse(nested);
  const file = create(t);
  writeFileSync(file, JSON.stringify(state));
  succeeds(run("check", file));
  for (const command of [["lane", "1", "--branch", "fix/deep"], ["wait-set", "new slot"], ["wait-clear"]]) {
    succeeds(run(command[0], file, ...command.slice(1)));
    assert.equal(JSON.stringify(read(file).extra), nested);
  }
});

test("check accepts extras at exactly 2500 levels including root and arrays", (t) => {
  const nested = '['.repeat(2499) + "42" + ']'.repeat(2499);
  const file = create(t);
  const state = JSON.stringify(record());
  writeFileSync(file, state.slice(0, -1) + ',"extra":' + nested + "}\n");
  succeeds(run("check", file));
});

test("check and wait-clear refuse extras beyond 2500 levels without changing bytes", (t) => {
  const depth = 2500;
  const nested = '{"x":'.repeat(depth) + "42" + "}".repeat(depth);
  const file = create(t);
  const state = JSON.stringify(record());
  writeFileSync(file, state.slice(0, -1) + ',"extra":' + nested + "}\n");
  const before = readFileSync(file);
  for (const command of ["check", "wait-clear"]) {
    const result = run(command, file);
    fails(result, 1, ["root"]);
    assert.equal(result.stderr, "root: nested deeper than 2500 levels; cannot be rewritten safely\n");
    assert.deepEqual(readFileSync(file), before);
  }
});

for (const [command, change, location] of [
  [["lane", "1", "--status", "idle"], (s) => { s.lanes["1"].issue = "OVERFLOW"; }, "lanes.1.issue"],
  [["wait-set", "new slot"], (s) => { s.wait.since = "OVERFLOW"; }, "wait.since"],
  [["wait-clear"], (s) => { s.wait.extra.value = "OVERFLOW"; }, "wait.extra.value"],
  [["lane", "1", "--branch", "fix/other"], (s) => { s.evidence.value = "OVERFLOW"; }, "evidence.value"],
]) {
  test(`${command[0]} refuses an out-of-range number at ${location} without changing bytes`, (t) => {
    const state = record();
    change(state);
    const file = seed(t, state);
    writeFileSync(file, readFileSync(file, "utf8").replace('"OVERFLOW"', "1e400"));
    const before = readFileSync(file);
    const result = run(command[0], file, ...command.slice(1));
    fails(result, 1, [location]);
    assert.equal(result.stderr, `${location}: number is out of range and cannot be preserved\n`);
    assert.deepEqual(readFileSync(file), before);
  });
}

test("create makes every missing directory private under umask 0777 without changing ancestors", (t) => {
  const dir = dirname(dirname(stateFile(t)));
  chmodSync(dir, 0o755);
  const levels = [join(dir, "one"), join(dir, "one", "two"), join(dir, "one", "two", "three")];
  const file = join(levels[2], "finish.json");
  const result = spawnSync(process.execPath, ["-e", "process.umask(0o777); process.argv = [process.execPath, ...process.argv.slice(1)]; import(process.argv[1]);", script,
    "create", file, "--repository", "/project", "--run-key", "run-1", "--coordinator", "c1"], { encoding: "utf8" });
  succeeds(result);
  for (const level of levels) assert.equal(mode(level), 0o700);
  assert.equal(mode(dir), 0o755);
  assert.equal(mode(file), 0o600);
  succeeds(run("check", file));
});

test("concurrent creates share two missing directory levels without losing records", async (t) => {
  const root = dirname(dirname(stateFile(t)));
  const directory = join(root, "shared", "records");
  const launcher = `
    const fs = require("node:fs");
    const { syncBuiltinESMExports } = require("node:module");
    const directory = process.argv[1];
    let ready = false;
    for (const name of ["mkdirSync", "statSync"]) {
      const original = fs[name];
      fs[name] = (...args) => {
        try { return original(...args); }
        catch (error) {
          if (!ready && args[0] === directory && error.code === "ENOENT") {
            ready = true;
            fs.writeSync(1, "ready\\n");
            fs.readSync(0, Buffer.alloc(1), 0, 1, null);
          }
          throw error;
        }
      };
    }
    syncBuiltinESMExports();
    process.argv = [process.execPath, ...process.argv.slice(2)];
    import(process.argv[1]);
  `;
  const children = Array.from({ length: 4 }, (_, index) => {
    const file = join(directory, `finish-${index}.json`);
    const child = spawn(process.execPath, ["-e", launcher, directory, script,
      "create", file, "--repository", "/project", "--run-key", `run-${index}`, "--coordinator", "c1"], { timeout: 10000 });
    t.after(() => child.kill());
    let stdout = "";
    let stderr = "";
    let signalReady;
    const ready = new Promise((resolve) => { signalReady = resolve; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.startsWith("ready\n")) signalReady();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => {
        signalReady();
        resolve({ status, stdout: stdout.replace(/^ready\n/, ""), stderr });
      });
    });
    return { child, file, ready, done };
  });
  await Promise.all(children.map(({ ready }) => ready));
  for (const { child } of children) child.stdin.end("x");
  const results = await Promise.all(children.map(({ done }) => done));
  results.forEach(succeeds);
  children.forEach(({ file }, index) => {
    assert.deepEqual(read(file), { state_version: 1, repository: "/project", run_key: `run-${index}`, coordinator: { block: "c1" }, lanes: {} });
    succeeds(run("check", file));
    assert.equal(mode(file), 0o600);
  });
  assert.equal(mode(directory), 0o700);
  assert.equal(mode(dirname(directory)), 0o700);
});

for (const key of ["\n", "\u001b"]) {
  test(`check escapes lane key ${JSON.stringify(key)} in one diagnostic line`, (t) => {
    const state = record();
    state.lanes[key] = state.lanes["1"];
    delete state.lanes["1"];
    const file = seed(t, state);
    const before = readFileSync(file);
    const result = run("check", file);
    fails(result, 1, [`lanes.${JSON.stringify(key)}`]);
    assert.equal(result.stderr, `lanes.${JSON.stringify(key)}: lane key must be a decimal lane number without leading zeros\n`);
    assert.equal(result.stderr.includes("\u001b"), false);
    assert.deepEqual(readFileSync(file), before);
  });
}

test("number diagnostics quote unsafe nested keys including dots and control characters", (t) => {
  const state = record();
  state.evidence["a.b"] = { "\n\u001b": ["OVERFLOW"] };
  const file = seed(t, state);
  writeFileSync(file, readFileSync(file, "utf8").replace('"OVERFLOW"', "1e400"));
  const before = readFileSync(file);
  const expected = 'evidence."a.b"."\\n\\u001b".0: number is out of range and cannot be preserved\n';
  for (const command of [["check"], ["wait-clear"]]) {
    const result = run(command[0], file);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, expected);
    assert.equal(result.stderr.trimEnd().split("\n").length, 1);
    assert.equal(result.stderr.includes("\u001b"), false);
    assert.deepEqual(readFileSync(file), before);
  }
});

test("lane interrupted preserves issue, branch and panes and removes a prior park reason", (t) => {
  const before = record();
  const file = seed(t, before);
  succeeds(run("lane", file, "1", "--status", "interrupted"));
  let lane = read(file).lanes["1"];
  assert.equal(lane.status, "interrupted");
  assert.equal(lane.issue, "126");
  assert.equal(lane.branch, "fix/state");
  assert.equal(lane.pane, "p2");
  assert.deepEqual(lane.panes, ["p1", "p2"]);
  succeeds(run("lane", file, "1", "--status", "parked", "--park-reason", "Needs input"));
  succeeds(run("lane", file, "1", "--status", "working"));
  assert.equal(read(file).lanes["1"].status, "working");
  succeeds(run("lane", file, "1", "--status", "parked", "--park-reason", "Needs input"));
  succeeds(run("lane", file, "1", "--status", "interrupted"));
  lane = read(file).lanes["1"];
  assert.equal(lane.status, "interrupted");
  assert.equal(lane.issue, "126");
  assert.equal(lane.branch, "fix/state");
  assert.equal(lane.pane, "p2");
  assert.deepEqual(lane.panes, ["p1", "p2"]);
  assert.equal(Object.hasOwn(lane, "park_reason"), false);
  preserved(file, before);
});

test("check requires a coordinator object with a block without changing bytes or mode", (t) => {
  for (const coordinator of [undefined, null, [], "c1", 7]) {
    const state = record();
    if (coordinator === undefined) delete state.coordinator;
    else state.coordinator = coordinator;
    const file = seed(t, state);
    chmodSync(file, 0o640);
    const before = readFileSync(file);
    const result = run("check", file);
    fails(result, 1, ["coordinator"]);
    assert.equal(result.stderr, "coordinator: must be an object with a block\n");
    assert.deepEqual(readFileSync(file), before);
    assert.equal(mode(file), 0o640);
  }
});

test("check requires a non-empty coordinator block without changing bytes or mode", (t) => {
  for (const block of [undefined, "", " ", 7, null]) {
    const state = record();
    state.coordinator = block === undefined ? {} : { block };
    const file = seed(t, state);
    chmodSync(file, 0o640);
    const before = readFileSync(file);
    const result = run("check", file);
    fails(result, 1, ["coordinator.block"]);
    assert.equal(result.stderr, "coordinator.block: must be a non-empty string\n");
    assert.deepEqual(readFileSync(file), before);
    assert.equal(mode(file), 0o640);
  }
});

test("create requires --coordinator as a usage argument without creating directories", (t) => {
  const file = stateFile(t);
  const result = run("create", file, "--repository", "/project", "--run-key", "run-1");
  fails(result, 2, ["usage"]);
  assert.equal(result.stderr, "usage: create FILE --repository PATH --run-key KEY --coordinator ID\n");
  assert.equal(existsSync(dirname(file)), false);
});

test("coordinator replaces its block while preserving extras and private mode", (t) => {
  const before = record();
  before.coordinator.extra = { keep: [1, null] };
  const file = seed(t, before);
  chmodSync(file, 0o644);
  succeeds(run("coordinator", file, "c2"));
  assert.deepEqual(read(file), { ...before, coordinator: { block: "c2", extra: { keep: [1, null] } } });
  preserved(file, before);
});

test("coordinator replaces a non-object without retaining its contents", (t) => {
  const state = record();
  state.coordinator = "old coordinator";
  const file = seed(t, state);
  chmodSync(file, 0o644);
  succeeds(run("coordinator", file, "c2"));
  assert.deepEqual(read(file), { ...state, coordinator: { block: "c2" } });
  assert.equal(mode(file), 0o600);
  succeeds(run("check", file));
  assert.deepEqual(readdirSync(dirname(file)), ["finish.json"]);
});

test("panes belong to only one lane in lane key order and refused writes preserve bytes and mode", (t) => {
  const state = record();
  const pane = 'shared\n"pane';
  state.lanes = {
    "10": { issue: "128", branch: null, pane, panes: [pane], status: "working" },
    "2": { issue: "127", branch: null, pane, panes: [pane], status: "working" },
    "1": { issue: "126", branch: null, pane, panes: [pane], status: "working" },
  };
  const file = seed(t, state);
  chmodSync(file, 0o640);
  const before = readFileSync(file);
  for (const command of [["check"], ["lane", "1", "--branch", "fix/other"]]) {
    const result = run(command[0], file, ...command.slice(1));
    fails(result, 1, ["lanes.2.panes", "lanes.10.panes"]);
    assert.equal(result.stderr, 'lanes.2.panes: pane ID "shared\\n\\"pane" already belongs to lane 1\nlanes.10.panes: pane ID "shared\\n\\"pane" already belongs to lane 1\n');
    assert.deepEqual(readFileSync(file), before);
    assert.equal(mode(file), 0o640);
    assert.deepEqual(readdirSync(dirname(file)), ["finish.json"]);
  }
});

test("wait resource rejects a line feed in check and wait-set without changing bytes or mode", (t) => {
  const state = record();
  state.wait.resource = "build\nslot";
  const invalid = seed(t, state);
  const file = seed(t);
  for (const [target, command] of [[invalid, ["check"]], [file, ["wait-set", "build\nslot"]]]) {
    chmodSync(target, 0o640);
    const before = readFileSync(target);
    const result = run(command[0], target, ...command.slice(1));
    fails(result, 1, ["wait.resource"]);
    assert.equal(result.stderr, "wait.resource: must not contain a line break\n");
    assert.deepEqual(readFileSync(target), before);
    assert.equal(mode(target), 0o640);
    assert.deepEqual(readdirSync(dirname(target)), ["finish.json"]);
  }
});

test("wait resource rejects a carriage return in check and wait-set without changing bytes or mode", (t) => {
  const state = record();
  state.wait.resource = "build\rslot";
  const invalid = seed(t, state);
  const file = seed(t);
  for (const [target, command] of [[invalid, ["check"]], [file, ["wait-set", "build\rslot"]]]) {
    chmodSync(target, 0o640);
    const before = readFileSync(target);
    const result = run(command[0], target, ...command.slice(1));
    fails(result, 1, ["wait.resource"]);
    assert.equal(result.stderr, "wait.resource: must not contain a line break\n");
    assert.deepEqual(readFileSync(target), before);
    assert.equal(mode(target), 0o640);
    assert.deepEqual(readdirSync(dirname(target)), ["finish.json"]);
  }
});

test("park reason rejects a line feed in check and lane without changing bytes or mode", (t) => {
  const state = record();
  state.lanes["1"].status = "parked";
  state.lanes["1"].park_reason = "Needs\ninput";
  const invalid = seed(t, state);
  const file = seed(t);
  for (const [target, command] of [[invalid, ["check"]], [file, ["lane", "1", "--status", "parked", "--park-reason", "Needs\ninput"]]]) {
    chmodSync(target, 0o640);
    const before = readFileSync(target);
    const result = run(command[0], target, ...command.slice(1));
    fails(result, 1, ["lanes.1.park_reason"]);
    assert.equal(result.stderr, "lanes.1.park_reason: must not contain a line break\n");
    assert.deepEqual(readFileSync(target), before);
    assert.equal(mode(target), 0o640);
    assert.deepEqual(readdirSync(dirname(target)), ["finish.json"]);
  }
});

test("park reason rejects a carriage return in check and lane without changing bytes or mode", (t) => {
  const state = record();
  state.lanes["1"].status = "parked";
  state.lanes["1"].park_reason = "Needs\rinput";
  const invalid = seed(t, state);
  const file = seed(t);
  for (const [target, command] of [[invalid, ["check"]], [file, ["lane", "1", "--status", "parked", "--park-reason", "Needs\rinput"]]]) {
    chmodSync(target, 0o640);
    const before = readFileSync(target);
    const result = run(command[0], target, ...command.slice(1));
    fails(result, 1, ["lanes.1.park_reason"]);
    assert.equal(result.stderr, "lanes.1.park_reason: must not contain a line break\n");
    assert.deepEqual(readFileSync(target), before);
    assert.equal(mode(target), 0o640);
    assert.deepEqual(readdirSync(dirname(target)), ["finish.json"]);
  }
});

test("create refuses an existing file without changing its directory mode, bytes or file mode", (t) => {
  const file = create(t);
  chmodSync(dirname(file), 0o751);
  chmodSync(file, 0o640);
  const before = readFileSync(file);
  const result = run("create", file, "--repository", "/project", "--run-key", "run-2", "--coordinator", "c2");
  fails(result, 1, ["file"]);
  assert.equal(result.stderr, "file: already exists\n");
  assert.deepEqual(readFileSync(file), before);
  assert.equal(mode(dirname(file)), 0o751);
  assert.equal(mode(file), 0o640);
  assert.deepEqual(readdirSync(dirname(file)), ["finish.json"]);
});

test("coordinator requires FILE and ID as usage arguments without changing bytes or mode", (t) => {
  const file = seed(t);
  chmodSync(file, 0o640);
  const before = readFileSync(file);
  const result = run("coordinator", file);
  fails(result, 2, ["usage"]);
  assert.equal(result.stderr, "usage: coordinator FILE ID\n");
  assert.deepEqual(readFileSync(file), before);
  assert.equal(mode(file), 0o640);
});

test("pane replacement on a parked lane preserves issue, branch, park reason and parked status", (t) => {
  const before = record();
  before.lanes["1"].status = "parked";
  before.lanes["1"].park_reason = "Needs input";
  const file = seed(t, before);
  chmodSync(file, 0o644);
  succeeds(run("lane", file, "1", "--pane", "p3"));
  assert.deepEqual(read(file), {
    ...before,
    lanes: { "1": { ...before.lanes["1"], pane: "p3", panes: ["p1", "p2", "p3"] } },
  });
  preserved(file, before);
});

test("coordinator creates a missing object without changing unrelated fields", (t) => {
  const state = record();
  delete state.coordinator;
  const file = seed(t, state);
  chmodSync(file, 0o644);
  succeeds(run("coordinator", file, "c2"));
  assert.deepEqual(read(file), { ...state, coordinator: { block: "c2" } });
  assert.equal(mode(file), 0o600);
  succeeds(run("check", file));
  assert.deepEqual(readdirSync(dirname(file)), ["finish.json"]);
});

test("coordinator refuses an empty block without changing bytes or mode", (t) => {
  const file = seed(t);
  chmodSync(file, 0o640);
  const before = readFileSync(file);
  const result = run("coordinator", file, "");
  fails(result, 1, ["coordinator.block"]);
  assert.equal(result.stderr, "coordinator.block: must be a non-empty string\n");
  assert.deepEqual(readFileSync(file), before);
  assert.equal(mode(file), 0o640);
  assert.deepEqual(readdirSync(dirname(file)), ["finish.json"]);
});

test("lane refuses a replacement pane owned by another lane without changing bytes or mode", (t) => {
  const state = record();
  state.lanes["2"] = { issue: "127", branch: "fix/other", pane: "p4", panes: ["p3", "p4"], status: "working" };
  const file = seed(t, state);
  succeeds(run("check", file));
  chmodSync(file, 0o640);
  const before = readFileSync(file);
  const result = run("lane", file, "1", "--pane", "p3");
  fails(result, 1, ["lanes.2.panes"]);
  assert.equal(result.stderr, 'lanes.2.panes: pane ID "p3" already belongs to lane 1\n');
  assert.deepEqual(readFileSync(file), before);
  assert.equal(mode(file), 0o640);
  assert.deepEqual(readdirSync(dirname(file)), ["finish.json"]);
});
