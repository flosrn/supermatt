import { test } from "node:test";
import assert from "node:assert/strict";
import { grade, parseTrace, verdict, redact, selectCases, reviewResults, collectState, comparisonStatus, planComparison, absentResult } from "../scripts/lib/skill-evals.mjs";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
function stubRun(t, repo, baseline, candidate) {
  const scratch = mkdtempSync(join(tmpdir(), "supermatt-evals-run-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const codexHome = join(scratch, "codex-home"); mkdirSync(codexHome);
  const env = { ...process.env, CODEX_HOME: codexHome, TMPDIR: scratch };
  delete env.OPENAI_API_KEY;
  const result = spawnSync(process.execPath, [resolve("scripts/evaluate-skills.mjs"), "--model", "test", "--repo", repo, "--codex", resolve("tests/fixtures/codex-stub.cjs"),
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
