import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { grade, parseTrace, verdict, redact, selectCases, reviewResults, collectState, comparisonStatus, planComparison, absentResult } from "../scripts/lib/skill-evals.mjs";
import { chmodSync, constants, copyFileSync, existsSync, mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { run, digest, save } from "../scripts/lib/skill-evidence.mjs";
import { cases } from "./evals/cases.mjs";

// A hook in a linked worktree exports an absolute GIT_DIR, which would aim every git command below at the real repo.
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete process.env[name];

const skill = { path: "/plugin/skills/example/SKILL.md", body: "SKILL CONTENT\n" };
const events = [
  { type: "thread.started", thread_id: "test" },
  { type: "item.completed", item: { type: "command_execution", command: `cat ${skill.path}`, exit_code: 0, aggregated_output: skill.body } },
  { type: "item.completed", item: { type: "agent_message", text: "Evidence report" } },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } },
];
const trace = input => input.map(item => JSON.stringify(item)).join("\n") + "\n";
const sample = { id: "control", skill: "example", unchanged: true, rubric: ["Judge the conclusion against the fixture"] };
const observation = { events, skill, before: { "code.mjs": "original" }, after: { "code.mjs": "original" }, process: { code: 0 } };

test("trace requires a completed turn, a final answer and valid JSON", () => {
  assert.equal(parseTrace(trace(events)).length, 4);
  assert.throws(() => parseTrace("not json"), /JSON/);
  assert.throws(() => parseTrace(trace([null, ...events])), /Malformed trace event/);
  assert.throws(() => parseTrace(trace(events.slice(0, -1))), /complete/);
  assert.throws(() => parseTrace(trace(events.filter(e => e.item?.type !== "agent_message"))), /answer/);
  assert.throws(() => parseTrace(trace([...events, { type: "error", message: "transport lost" }])), /error/);
});

test("target exposure, process outcome and changed state have independent controls", () => {
  assert.equal(grade(sample, observation).status, "needs review");
  assert.equal(grade(sample, { ...observation, events: events.filter(e => e.item?.type !== "command_execution") }).status, "blocked");
  assert.equal(grade(sample, { ...observation, process: { code: 1 } }).status, "blocked");
  assert.equal(grade(sample, { ...observation, process: { timedOut: true } }).status, "blocked");
  assert.equal(grade(sample, { ...observation, after: { "code.mjs": "edited" } }).status, "fail");
  assert.equal(grade(sample, { ...observation, events: [...events, { type: "item.completed", item: { type: "file_change", changes: [{ path: "code.mjs" }] } }] }).status, "fail");
  assert.equal(grade(sample, { ...observation, events: [...events, { type: "item.completed", item: { type: "file_change", changes: [{ path: "/temporary/report.md" }] } }] }).status, "needs review");
});

test("successful result is required for expected output, not a promised phrase", () => {
  const item = { ...sample, unchanged: false, requiredFile: "result.txt", expectedBytes: "42\n" };
  assert.equal(grade(item, observation).status, "fail");
  assert.equal(grade(item, { ...observation, after: { ...observation.after, "result.txt": "42\n" } }).status, "needs review");
});

test("trace order is retained and a late skill read cannot prove initial exposure", () => {
  const late = [events[0], { type: "item.completed", item: { type: "command_execution", command: "echo work", exit_code: 0 } }, ...events.slice(1)];
  assert.equal(grade(sample, { ...observation, events: late }).status, "blocked");
  const earlyEdit = { type: "item.completed", item: { type: "file_change", changes: [{ path: "result.txt", kind: "add" }] } };
  assert.equal(grade({ ...sample, unchanged: false }, { ...observation, events: [earlyEdit, ...events] }).status, "blocked");
  const combined = structuredClone(events); combined[1].item.command = `touch result.txt; cat ${skill.path}`;
  assert.equal(grade(sample, { ...observation, events: combined }).status, "blocked");
  const wrapped = structuredClone(events); wrapped[1].item.command = `/bin/zsh -c 'cat ${skill.path}'`;
  assert.equal(grade(sample, { ...observation, events: wrapped }).status, "needs review");
});

test("work cannot start before exposure and finish after it", () => {
  const started = { type: "item.started", item: { id: "edit", type: "file_change", changes: [{ path: "result.txt" }] } };
  const finished = { ...started, type: "item.completed" };
  assert.equal(grade({ ...sample, unchanged: false }, { ...observation, events: [started, ...events.slice(0, 2), finished, ...events.slice(2)] }).status, "blocked");
  const reading = { type: "item.started", item: { ...events[1].item, id: "read", exit_code: null, aggregated_output: "" } };
  const read = { type: "item.completed", item: { ...events[1].item, id: "read" } };
  assert.equal(grade(sample, { ...observation, events: [events[0], reading, read, ...events.slice(2)] }).status, "needs review");
});

test("adjudication is bound to evidence and cannot override failed checks", () => {
  const results = [{ id: "one", status: "needs review", evidenceDigest: "abc", rubric: ["Check evidence"] }];
  const reviews = [{ id: "one", evidenceDigest: "abc", verdict: "pass", reviewer: "maintainer", rationale: "Observed the required outcome", evidence: ["one/trace.jsonl:2"] }];
  assert.equal(reviewResults(results, reviews)[0].status, "pass");
  assert.throws(() => reviewResults(results, [{ ...reviews[0], evidenceDigest: "stale" }]), /digest/);
  assert.throws(() => reviewResults(results, [{ ...reviews[0], rationale: "" }]), /rationale/);
  assert.throws(() => reviewResults([{ ...results[0], status: "fail" }], reviews), /override/);
  assert.equal(verdict([{ status: "pass" }, { status: "blocked" }]), "blocked");
  assert.equal(verdict([{ status: "needs review" }]), "needs review");
});

test("corpus selection fails closed and each behavior has a review rubric", () => {
  assert.throws(() => selectCases(cases, "unknown"), /Unknown case/);
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  for (const c of cases) {
    assert.ok(c.skill && c.prompt && c.rubric.length && Object.keys(c.files).length, c.id);
    assert.ok(c.unchanged || c.requiredFile || c.id === "handoff", `${c.id}: no observable outcome`);
  }
});

test("redaction covers explicit credentials and common token assignments", () => {
  const text = 'Authorization: Bearer fake-token\napi_key="fake-key"\n{"access_token":"json-token"}\nprivate-secret';
  assert.doesNotMatch(redact(text, ["private-secret"]), /fake-token|fake-key|json-token|private-secret/);
});

test("collection records symlinks without following them and retains other evidence", t => {
  const root = mkdtempSync(join(tmpdir(), "supermatt-capture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "report.md"), "real evidence\n");
  writeFileSync(join(root, "cache.bin"), Buffer.from([0, 255]));
  writeFileSync(join(root, "__proto__"), "must be captured\n");
  symlinkSync("/outside/secret", join(root, "escape"));
  const captured = collectState(root);
  assert.equal(captured.state["report.md"], "real evidence\n");
  assert.equal(Object.hasOwn(captured.state, "__proto__"), true);
  assert.equal(captured.state.__proto__, "must be captured\n");
  assert.deepEqual(captured.state.escape, { kind: "symlink", target: "/outside/secret" });
  assert.equal(captured.state["cache.bin"].kind, "binary");
  assert.match(captured.errors[0], /Unfollowed symlink/);
});

test("candidate acceptance permits a measured baseline failure but not incomplete runs", () => {
  const report = { plannedModelCalls: 2, completedRuns: 2, results: [{ id: "baseline-one", status: "fail" }, { id: "candidate-one", status: "pass" }] };
  assert.equal(comparisonStatus(report), "pass");
  assert.equal(comparisonStatus({ ...report, plannedModelCalls: 4 }), "blocked");
  assert.equal(comparisonStatus({ ...report, error: "cleanup failed" }), "blocked");
  assert.equal(comparisonStatus({ ...report, results: [{ id: "baseline-one", status: "needs review" }, { id: "candidate-one", status: "fail" }] }), "fail");
  assert.equal(comparisonStatus({ ...report, plannedModelCalls: undefined }), "blocked");
  assert.equal(comparisonStatus({ ...report, results: [{ id: "candidate-one", status: "pass" }, { id: "candidate-one", status: "pass" }] }), "blocked");
  assert.equal(verdict([{ status: "unknown" }]), "blocked");
});

test("a case whose skill the baseline lacks is planned without baseline runs; one the candidate lacks stops before any run", () => {
  const selected = [{ id: "old", skill: "qa" }, { id: "new", skill: "babysit-pr" }];
  const skills = { baseline: new Set(["qa"]), candidate: new Set(["qa", "babysit-pr"]) };
  const plan = planComparison(selected, skills, { conditions: ["neutral", "competing"], repetitions: 3 });
  assert.deepEqual(plan, { absent: ["new"], plannedRuns: 18, absentRuns: 6 });
  assert.throws(() => planComparison(selected, { ...skills, candidate: new Set(["qa"]) }, { conditions: ["neutral"], repetitions: 1 }), /candidate.*babysit-pr/);
});

test("absent baseline rows complete a comparison only in the baseline arm and as accounted", () => {
  const report = { plannedRuns: 3, absentRuns: 1, completedRuns: 4, results: [
    { id: "baseline-old-neutral-1", status: "fail" }, absentResult("baseline-new-neutral-1"),
    { id: "candidate-old-neutral-1", status: "pass" }, { id: "candidate-new-neutral-1", status: "pass" },
  ] };
  assert.equal(comparisonStatus(report), "pass");
  assert.equal(comparisonStatus({ ...report, absentRuns: 0 }), "blocked", "an absent row the plan did not account for");
  const swapped = report.results.map(r => r.id === "baseline-new-neutral-1" ? { ...r, id: "baseline-old-neutral-2" } : r);
  assert.equal(comparisonStatus({ ...report, results: swapped }), "blocked", "rows must pair across arms");
  const candidateAbsent = report.results.map(r => r.id === "candidate-new-neutral-1" ? absentResult(r.id) : r);
  assert.equal(comparisonStatus({ ...report, results: candidateAbsent }), "blocked", "the candidate arm is never absent");
  const review = { id: "baseline-new-neutral-1", verdict: "pass", reviewer: "r", rationale: "r", evidence: ["x:1"] };
  assert.throws(() => reviewResults(report.results, [review]), /Cannot override/, "an absent row has nothing to adjudicate");
});

test("CLI rejects a timeout above five minutes before launching a model", async () => {
  await assert.rejects(run(process.execPath, ["scripts/evaluate-skills.mjs", "--model", "test", "--baseline", "HEAD", "--timeout", "301", "--dry-run"]), /1\.\.300/);
});

test("CLI adjudication preserves incomplete status and detects evidence mutation", async t => {
  const root = mkdtempSync(join(tmpdir(), "supermatt-adjudication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = "candidate-report-only-neutral-1", directory = join(root, id); mkdirSync(directory);
  writeFileSync(join(directory, "trace.jsonl"), trace(events));
  save(join(directory, "observation.json"), { ...observation, traceDigest: digest(trace(events)) });
  const hash = digest(readFileSync(join(directory, "observation.json")));
  save(join(root, "report.json"), { plannedRuns: 2, completedRuns: 1, harnessFiles: { "tests/evals/cases.mjs": digest(readFileSync("tests/evals/cases.mjs")) }, results: [{ id, status: "needs review", evidenceDigest: hash }] });
  save(join(root, "reviews.json"), [{ id, evidenceDigest: hash, verdict: "pass", reviewer: "test control", rationale: "Control only", evidence: [`${id}/observation.json:1`] }]);
  const args = [resolve("scripts/evaluate-skills.mjs"), "--adjudicate", root, "--reviews", join(root, "reviews.json")];
  await assert.rejects(run(process.execPath, args), /exit 1/);
  assert.equal(JSON.parse(readFileSync(join(root, "adjudicated-report.json"))).status, "blocked");
  writeFileSync(join(directory, "trace.jsonl"), "changed\n");
  await assert.rejects(run(process.execPath, args), /Saved trace changed/);
});

test("CLI adjudication rechecks mechanical failures before accepting a review", async t => {
  const root = mkdtempSync(join(tmpdir(), "supermatt-recheck-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = "candidate-report-only-neutral-1", directory = join(root, id); mkdirSync(directory);
  const savedTrace = trace(events);
  writeFileSync(join(directory, "trace.jsonl"), savedTrace);
  save(join(directory, "observation.json"), { ...observation, after: { "code.mjs": "edited" }, traceDigest: digest(savedTrace) });
  const hash = digest(readFileSync(join(directory, "observation.json")));
  save(join(root, "report.json"), { plannedRuns: 2, completedRuns: 2, harnessFiles: { "tests/evals/cases.mjs": digest(readFileSync("tests/evals/cases.mjs")) }, results: [
    { id: "baseline-report-only-neutral-1", status: "pass" },
    { id, status: "needs review", evidenceDigest: hash },
  ] });
  save(join(root, "reviews.json"), [{ id, evidenceDigest: hash, verdict: "pass", reviewer: "test control", rationale: "Control only", evidence: [`${id}/observation.json:1`] }]);
  const args = [resolve("scripts/evaluate-skills.mjs"), "--adjudicate", root, "--reviews", join(root, "reviews.json")];
  await assert.rejects(run(process.execPath, args), /Cannot override fail/);
  save(join(root, "reviews.json"), []);
  await assert.rejects(run(process.execPath, args), /exit 1/);
  const checked = JSON.parse(readFileSync(join(root, "adjudicated-report.json")));
  assert.equal(checked.status, "fail");
  assert.equal(checked.results.find(result => result.id === id).status, "fail");
});

// A repository whose first commit predates the Cursor manifest and the babysit-pr skill, as
// main did before babysit-pr; the next commit adds the Cursor manifest, the last the skill.
function history(t) {
  const repo = mkdtempSync(join(tmpdir(), "supermatt-evals-history-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
  const commit = files => {
    for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), body); }
    git("add", "-A"); git("commit", "-qm", "snapshot");
    return git("rev-parse", "HEAD");
  };
  const skillFiles = name => ({ [`skills/${name}/SKILL.md`]: `---\nname: ${name}\n---\n`, [`skills/${name}/agents/openai.yaml`]: "policy:\n  allow_implicit_invocation: true\n" });
  git("init", "-q", "-b", "main");
  const beforeCursor = commit({ ".claude-plugin/plugin.json": '{"name":"supermatt"}', ".agents/plugins/marketplace.json": '{"name":"supermatt","plugins":[{"name":"supermatt"}]}', ...skillFiles("qa") });
  const beforeSkill = commit({ ".cursor-plugin/plugin.json": '{"name":"supermatt"}' });
  const withSkill = commit(skillFiles("babysit-pr"));
  return { repo, beforeCursor, beforeSkill, withSkill };
}

// Plans a qa case and a babysit-pr case, one variant, two runs each.
const dryRun = (repo, baseline, candidate) => spawnSync(process.execPath, [resolve("scripts/evaluate-skills.mjs"), "--model", "test", "--repo", repo,
  "--baseline", baseline, "--candidate", candidate, "--cases", "blocked-qa,babysit-feedback-first", "--variants", "neutral", "--runs", "2", "--dry-run"], { encoding: "utf8" });

test("CLI dry run against a baseline that predates the Cursor manifest and a new skill plans the new skill as absent there", t => {
  const { repo, beforeCursor, withSkill } = history(t);
  const result = dryRun(repo, beforeCursor, withSkill);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual([plan.baselineAbsent, plan.plannedRuns], [["babysit-feedback-first"], 6]);
});

test("CLI dry run stops, naming the skill, when the candidate lacks a selected skill", t => {
  const { repo, beforeCursor, beforeSkill } = history(t);
  const result = dryRun(repo, beforeCursor, beforeSkill);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /babysit-pr/);
  assert.equal(result.stdout, "", "no plan is printed");
});

test("CLI dry run stops on a candidate that lacks the Cursor manifest, before it checks the corpus", t => {
  const { repo, beforeCursor } = history(t);
  const result = dryRun(repo, beforeCursor, beforeCursor);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /\.cursor-plugin\/plugin\.json/);
});

// A full run with the stub Codex: it freezes both arms, installs and lists the baseline, then
// stops at the auth check, since CODEX_HOME is empty and no API key is set. No model is called.
function stubRun(t, repo, baseline, candidate, { failPreflight = false, unrelatedCanary, sandbox = "" } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "supermatt-evals-run-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const codexHome = join(scratch, "codex-home"); mkdirSync(codexHome);
  const env = { ...process.env, CODEX_HOME: codexHome, TMPDIR: scratch };
  delete env.OPENAI_API_KEY;
  let codex = resolve("tests/fixtures/codex-stub.cjs");
  if (failPreflight || unrelatedCanary || sandbox) {
    const stub = codex;
    codex = join(scratch, "codex.cjs");
    // `sandbox` is source run before the stub's sandbox answer, with `fs`, `path` and `args` in scope.
    writeFileSync(codex, `#!/usr/bin/env node\nconst fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2);\nif (args[0] === "sandbox") {\n${unrelatedCanary ? `fs.writeFileSync(${JSON.stringify(unrelatedCanary)}, "another evaluation owns this file\\n", { flag: "wx" });` : ""}\n${sandbox}\n${failPreflight ? 'console.error("preflight rejected"); process.exit(1);' : ""}\n}\nrequire(${JSON.stringify(stub)});\n`, { mode: 0o755 });
  }
  const result = spawnSync(process.execPath, [resolve("scripts/evaluate-skills.mjs"), "--model", "test", "--repo", repo, "--codex", codex,
    "--baseline", baseline, "--candidate", candidate, "--cases", "blocked-qa,babysit-feedback-first", "--variants", "neutral", "--runs", "2"], { encoding: "utf8", env });
  const summary = JSON.parse(result.stdout);
  return { summary, report: JSON.parse(readFileSync(join(summary.evidence, "report.json"), "utf8")) };
}

test("CLI run against a baseline that predates the Cursor manifest installs it and stops only for missing auth, before any model call", t => {
  const { repo, beforeCursor, withSkill } = history(t);
  const { summary, report } = stubRun(t, repo, beforeCursor, withSkill);
  assert.deepEqual([summary.error, summary.startedRuns], ["Native Codex auth is unavailable; no model calls started", 0]);
  assert.deepEqual([report.baselineAbsent, report.plannedRuns, report.absentRuns], [["babysit-feedback-first"], 6, 2]);
});

test("CLI cleanup reports only its own canaries while another evaluation's canary remains", t => {
  const { repo, beforeCursor, withSkill } = history(t);
  const unrelated = join(realpathSync("/tmp"), `supermatt-evals-canary-other-${process.pid}`);
  t.after(() => rmSync(unrelated, { force: true }));
  const { summary, report } = stubRun(t, repo, beforeCursor, withSkill, { unrelatedCanary: unrelated });
  assert.equal(summary.error, "Native Codex auth is unavailable; no model calls started");
  assert.ok(Array.isArray(report.isolation?.canaries), "the report must identify this invocation's canaries");
  assert.deepEqual(report.isolation.canaries.map(dirname).sort(), [...new Set(["/tmp", "/var/tmp"].filter(existsSync).map(path => realpathSync(path)))].sort());
  for (const path of report.isolation.canaries) assert.equal(existsSync(path), false, `canary remains: ${path}`);
  assert.equal(readFileSync(unrelated, "utf8"), "another evaluation owns this file\n");
});

test("CLI removes its recorded canaries after a rejected preflight without starting a model", t => {
  const { repo, beforeCursor, withSkill } = history(t);
  const { summary, report } = stubRun(t, repo, beforeCursor, withSkill, { failPreflight: true });
  assert.match(summary.error, /preflight rejected/);
  assert.equal(summary.startedRuns, 0);
  assert.equal(report.isolation.status, "blocked");
  assert.deepEqual(report.isolation.canaries.map(dirname).sort(), [...new Set(["/tmp", "/var/tmp"].filter(existsSync).map(path => realpathSync(path)))].sort());
  for (const path of report.isolation.canaries) assert.equal(existsSync(path), false, `canary remains: ${path}`);
});

// The host checks every canary's bytes after the sandbox exits, so a sandbox that changes one blocks the
// preflight even when the probe's output claims isolation. The baseline arm's preflight runs first, in
// `work/baseline-fixture` (the sandbox's -C directory), beside the grader canary and the arm's home.
for (const [change, canary, tamper, host] of [
  ["overwrites", "grader-canary", 'fs.writeFileSync(path.join(path.dirname(args[4]), "grader-canary"), "probe")', "changed"],
  ["deletes", "auth-canary", 'fs.rmSync(path.join(path.dirname(args[4]), "baseline-home", "auth-canary"))', "missing"],
]) test(`CLI blocks the preflight, naming the canary, when the sandbox ${change} a host canary and reports isolation verified`, t => {
  const { repo, beforeCursor, withSkill } = history(t);
  const { summary, report } = stubRun(t, repo, beforeCursor, withSkill, { sandbox: tamper });
  assert.deepEqual([report.isolation.status, summary.startedRuns], ["blocked", 0]);
  assert.ok(summary.error.includes(`${sep}${canary}`), summary.error);
  assert.equal(report.isolation.checks?.find(check => check.path.endsWith(`${sep}${canary}`))?.host, host);
});

// The probe prints a `canary {"path","read","write"}` line per canary (each outcome an error code or
// "success"), and the host judges them. This stub answer reports the same outcome for every canary,
// which the evaluator passes after the probe path.
const answer = (read, write) => `for (const path of args.slice(7)) console.log("canary " + JSON.stringify({ path, read: ${JSON.stringify(read)}, write: ${JSON.stringify(write)} }));\nconsole.log("isolation verified"); process.exit(0);`;
const linux = process.platform === "linux";
for (const [name, sandbox, passes, error] of [
  ["no outcome for its canaries", 'console.log("isolation verified"); process.exit(0);', false, /reported no outcome for canary/],
  ["a canary read that succeeded", answer("success", "EACCES"), false, /Read boundary not enforced/],
  // Bubblewrap does not mount an ungranted path and backs the parents of granted roots with a private tmpfs.
  ["hidden canaries and private writes", answer("ENOENT", "success"), linux, /Read boundary not enforced/],
  ["hidden canaries whose writes find no parent", answer("ENOENT", "ENOENT"), linux, /Read boundary not enforced/],
  ["canary writes denied by a read-only mount", answer("EACCES", "EROFS"), linux, /Write boundary not enforced/],
  ["a canary write that failed with an unexpected error", answer("EACCES", "EIO"), false, /Write boundary not enforced/],
]) test(`CLI preflight with a sandbox that reports ${name} ${passes ? "passes" : "is blocked"} on ${process.platform}`, t => {
  const { repo, beforeCursor, withSkill } = history(t);
  const { summary, report } = stubRun(t, repo, beforeCursor, withSkill, { sandbox });
  assert.equal(summary.startedRuns, 0);
  if (passes) assert.deepEqual([report.isolation.status, summary.error], ["pass", "Native Codex auth is unavailable; no model calls started"]);
  else { assert.equal(report.isolation.status, "blocked"); assert.match(summary.error, error); }
});

// Runs the evaluator on the real Codex CLI for one handoff run. Without an API key it stops right
// after the preflight. With `stubExec`, a dummy key lets it reach the run, where the sandboxed-exec
// fixture stands in for the model; a launcher hands that fixture the real CLI's path on each call.
const realCodex = spawnSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).stdout.trim();
const skipNative = { skip: !realCodex && "codex is not installed" };
function nativeRun(t, { stubExec = false, root = tmpdir(), runtime = process.execPath, codex = realCodex, toolchainPath = process.env.PATH } = {}) {
  const scratch = mkdtempSync(join(root, "supermatt-evals-native-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const codexHome = join(scratch, "codex-home"); mkdirSync(codexHome);
  const env = { ...process.env, PATH: toolchainPath, CODEX_HOME: codexHome, TMPDIR: scratch };
  delete env.OPENAI_API_KEY;
  if (stubExec) {
    codex = join(scratch, "codex");
    writeFileSync(codex, `#!/bin/sh\nREAL_CODEX=${JSON.stringify(realCodex)} exec ${JSON.stringify(resolve("tests/fixtures/codex-sandboxed-exec.sh"))} "$@"\n`, { mode: 0o755 });
    env.OPENAI_API_KEY = "dummy-key-for-a-stub-run";
  }
  const result = spawnSync(runtime, [resolve("scripts/evaluate-skills.mjs"), "--model", "test", "--codex", codex, "--baseline", "HEAD", "--candidate", "HEAD",
    "--cases", "handoff", "--variants", "neutral", "--runs", "1"], { encoding: "utf8", env });
  // Each started run prints a progress line before the closing JSON summary.
  const summary = JSON.parse(result.stdout.slice(result.stdout.search(/^\{/m)));
  return { summary, report: JSON.parse(readFileSync(join(summary.evidence, "report.json"), "utf8")) };
}

// Codex keeps a writable root's .git read-only unless the profile grants it, and the preflight's
// commit probe then fails with an index.lock error.
test("CLI preflight commits in the fixture repository under the real Codex sandbox", skipNative, t => {
  const { summary, report } = nativeRun(t);
  assert.deepEqual([summary.error, summary.startedRuns, report.isolation?.status], ["Native Codex auth is unavailable; no model calls started", 0, "pass"]);
  // The grader and auth canaries, then one per system temp directory, each with its sandboxed outcomes.
  assert.equal(report.isolation.checks.length, 2 + report.isolation.canaries.length);
  for (const check of report.isolation.checks) {
    assert.equal(check.host, "unchanged", check.path);
    assert.ok(typeof check.read === "string" && check.read !== "success", `${check.path} read: ${check.read}`);
    assert.equal(typeof check.write, "string", check.path);
  }
});

// macOS's os.tmpdir() is under /var/folders, so the test above never puts the evidence root, and
// with it the fixture and the grader and auth canaries, under /tmp, the scratch directory Codex's
// Seatbelt profile opens to sandboxed commands unless the permission profile denies it.
const systemTemp = ["/tmp", "/var/tmp"].filter(existsSync).map(path => realpathSync(path));
test("CLI preflight denies the system temp directories and still passes with the evidence root under /tmp", skipNative, t => {
  const { summary, report } = nativeRun(t, { root: "/tmp" });
  assert.equal(report.isolation.canaries.length, systemTemp.length);
  for (const path of report.isolation.canaries) assert.equal(existsSync(path), false, `canary remains: ${path}`);
  assert.deepEqual([summary.error, summary.startedRuns, report.isolation?.status], ["Native Codex auth is unavailable; no model calls started", 0, "pass"]);
  for (const dir of systemTemp) assert.ok(report.isolation.boundary.includes(dir), `${dir} is not among the denied paths`);
});

// This config/runtime smoke replaces the full preflight probe, but keeps real Codex discovery,
// configuration loading and sandbox execution. It does not call a model or spawn Git from Node.
for (const root of new Set(systemTemp)) for (const collision of ["runtime", "toolchain"]) {
  test(`CLI config/runtime smoke starts a ${collision} executable directly in ${root} without opening its siblings`, skipNative, t => {
    const executable = join(root, `supermatt-evals-runtime-${randomUUID()}`), sibling = `${executable}-private`;
    const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
    copyFileSync(realpathSync(node), executable, constants.COPYFILE_EXCL);
    t.after(() => rmSync(executable, { force: true }));
    writeFileSync(sibling, "private sibling\n", { flag: "wx" });
    t.after(() => rmSync(sibling, { force: true }));
    const scratch = mkdtempSync(join(tmpdir(), "supermatt-evals-runtime-smoke-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const bin = join(scratch, "bin"); mkdirSync(bin);
    symlinkSync(executable, join(bin, "node"));
    const runtime = collision === "runtime" ? executable : process.execPath;
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const startup = join(scratch, "startup.jsonl");
    const commands = [["runtime", '"$6"'], ["node", "node"]].map(([role, command]) => {
      const probe = `const assert = require("node:assert/strict"), fs = require("node:fs"), {createHash} = require("node:crypto");
assert.throws(() => fs.readFileSync(${JSON.stringify(sibling)}), error => ["EPERM", "EACCES", "ENOENT"].includes(error.code));
const forbiddenWrite = require("node:path").join(require("node:path").dirname(process.execPath), ${JSON.stringify(`runtime-write-${randomUUID()}`)});
assert.throws(() => fs.writeFileSync(forbiddenWrite, "unsafe"), error => ["EPERM", "EACCES", "EROFS"].includes(error.code));
fs.writeFileSync("runtime-started", "ok");
assert.equal(fs.readFileSync("runtime-started", "utf8"), "ok");
fs.unlinkSync("runtime-started");
console.log(JSON.stringify({role: ${JSON.stringify(role)}, executable: fs.realpathSync(process.execPath), digest: createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex")}));`;
      return `${quote(realCodex)} sandbox -P "$3" -C "$5" ${command} -e ${quote(probe)} >> ${quote(startup)} || exit $?`;
    });
    const codex = join(scratch, "codex");
    // Stands in for the probe's canary report too: the canaries follow the probe ("$7").
    const canaryReport = `shift 7\nfor canary; do printf 'canary {"path":"%s","read":"EACCES","write":"EACCES"}\\n' "$canary"; done`;
    writeFileSync(codex, `#!/bin/sh\n[ "$1" = sandbox ] || exec ${quote(realCodex)} "$@"\n${commands.join("\n")}\n${canaryReport}\nprintf 'isolation verified\\n'\n`, { mode: 0o755 });
    const { summary, report } = nativeRun(t, { runtime, codex,
      toolchainPath: collision === "toolchain" ? `${bin}:${process.env.PATH}` : process.env.PATH });
    assert.deepEqual([summary.error, summary.startedRuns, report.isolation?.status],
      ["Native Codex auth is unavailable; no model calls started", 0, "pass"]);
    assert.deepEqual(readFileSync(startup, "utf8").trim().split("\n").map(line => JSON.parse(line)), [
      { role: "runtime", executable: report.toolchain.runtime, digest: digest(readFileSync(realpathSync(runtime))) },
      { role: "node", executable: report.toolchain.node, digest: digest(readFileSync(collision === "toolchain" ? executable : realpathSync(node))) },
    ]);
    if (process.platform === "linux") {
      const effective = report.toolchain[collision === "runtime" ? "runtime" : "node"];
      assert.notEqual(effective, executable, "a colliding executable was not staged");
      assert.equal(systemTemp.some(root => effective.startsWith(`${root}/`)), false, "staging remains under a denied root");
      assert.equal(existsSync(dirname(effective)), false, "toolchain staging was not removed after the auth stop");
    }
  });
}

test("CLI disposes external runtime staging even when fixture cleanup fails", { skip: process.platform !== "linux" || process.getuid?.() === 0 }, t => {
  // HOME is where staging falls back to while the evidence root is under /tmp, so it must sit outside
  // the denied roots. On CI, os.tmpdir() is /tmp itself.
  const base = realpathSync(tmpdir());
  const scratch = mkdtempSync(join(systemTemp.some(root => base === root || base.startsWith(`${root}/`)) ? homedir() : base, "supermatt-evals-cleanup-"));
  const temp = mkdtempSync("/tmp/supermatt-evals-cleanup-");
  const runtime = join("/tmp", `supermatt-evals-runtime-${randomUUID()}`);
  const home = join(scratch, "home"); mkdirSync(home);
  const state = join(scratch, "state.json"), codex = join(scratch, "codex.cjs");
  let live;
  t.after(() => {
    if (live) {
      chmodSync(live.blocked, 0o700);
      rmSync(dirname(live.runtime), { recursive: true, force: true });
    }
    rmSync(scratch, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
    rmSync(runtime, { force: true });
  });
  copyFileSync(realpathSync(execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim()), runtime, constants.COPYFILE_EXCL);
  writeFileSync(codex, `#!/usr/bin/env node\nconst fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2);\nif (args[0] === "sandbox") {\n  const blocked = path.join(args[4], "unreadable"); fs.mkdirSync(blocked);\n  fs.writeFileSync(path.join(blocked, "owned.txt"), "fixture state"); fs.chmodSync(blocked, 0);\n  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify({ blocked, runtime: args[5] }));\n}\nrequire(${JSON.stringify(resolve("tests/fixtures/codex-stub.cjs"))});\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, TMPDIR: temp, CODEX_HOME: join(home, "empty-codex") };
  delete env.OPENAI_API_KEY;
  const result = spawnSync(runtime, [resolve("scripts/evaluate-skills.mjs"), "--model", "test", "--baseline", "HEAD", "--codex", codex,
    "--cases", "handoff", "--variants", "neutral", "--runs", "1"], { env, encoding: "utf8" });
  live = JSON.parse(readFileSync(state, "utf8"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EACCES|Permission denied/);
  assert.equal(existsSync(dirname(live.runtime)), false, "staging survived a fixture cleanup error");
});

test("a run's observation keeps commits a reset dropped and merge-resolution paths, and a file Git's configuration writes during capture blocks the run", skipNative, t => {
  const { summary, report } = nativeRun(t, { stubExec: true });
  assert.equal(summary.startedRuns, 1, summary.error);
  const observation = JSON.parse(readFileSync(join(summary.evidence, "baseline-handoff-neutral-1", "observation.json"), "utf8"));
  const commits = Object.fromEntries(observation.gitCommits.trim().split(/\n(?=[0-9a-f]{40} )/).map(entry => {
    const [header, ...paths] = entry.split("\n").filter(Boolean);
    return [header.slice(41), paths.sort()];
  }));
  assert.deepEqual(commits, { "dropped commit": ["A\tdropped.txt"], side: ["A\tside.txt"], main: ["A\tmain.txt"],
    "merge side": ["A\tresolution-only.txt", "A\tside.txt"] });
  // The run is graded on the state before Git's reads, and their change to the fixture blocks it.
  assert.equal(observation.after["late.txt"], undefined);
  assert.deepEqual(observation.captureErrors, ["Fixture or artifacts changed while Git state was read"]);
  assert.equal(report.results[0].status, "blocked");
});

// A comparison of one existing case ("old") and one new skill's case ("new"), one variant, one run.
const pairedReport = results => ({ plannedRuns: 3, absentRuns: 1, completedRuns: 4, results });

test("a comparison whose plan expects an absent baseline row it does not have is blocked", () => {
  const report = pairedReport([{ id: "baseline-old-neutral-1", status: "pass" }, { id: "baseline-new-neutral-1", status: "pass" },
    { id: "candidate-old-neutral-1", status: "pass" }, { id: "candidate-new-neutral-1", status: "pass" }]);
  assert.equal(comparisonStatus(report), "blocked");
});

test("an absent row in the candidate arm blocks the comparison even when a candidate run failed", () => {
  const report = pairedReport([{ id: "baseline-old-neutral-1", status: "pass" }, { id: "baseline-new-neutral-1", status: "pass" },
    { id: "candidate-old-neutral-1", status: "fail" }, absentResult("candidate-new-neutral-1")]);
  assert.equal(comparisonStatus(report), "blocked");
});

test("a blocked baseline run blocks the comparison even when the candidate failed", () => {
  const report = { plannedRuns: 2, completedRuns: 2, results: [{ id: "baseline-one", status: "blocked" }, { id: "candidate-one", status: "fail" }] };
  assert.equal(comparisonStatus(report), "blocked");
});

test("rows that belong to neither arm block the comparison instead of standing in for a run", () => {
  const report = { plannedRuns: 4, completedRuns: 4, results: [{ id: "baseline-one", status: "pass" }, { id: "candidate-one", status: "pass" },
    { id: "other-one", status: "pass" }, { id: "other-two", status: "pass" }] };
  assert.equal(comparisonStatus(report), "blocked");
});

test("a baseline run with an unknown status blocks the comparison", () => {
  const report = { plannedRuns: 2, completedRuns: 2, results: [{ id: "baseline-one", status: "crashed" }, { id: "candidate-one", status: "pass" }] };
  assert.equal(comparisonStatus(report), "blocked");
});

test("a baseline run that needs review keeps a passing candidate's comparison at needs review", () => {
  const report = { plannedRuns: 2, completedRuns: 2, results: [{ id: "baseline-one", status: "needs review" }, { id: "candidate-one", status: "pass" }] };
  assert.equal(comparisonStatus(report), "needs review");
});
