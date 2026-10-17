import { test } from "node:test";
import assert from "node:assert/strict";
import { grade, parseTrace, verdict, redact, selectCases, reviewResults, collectState, comparisonStatus, planComparison, absentResult } from "../scripts/lib/skill-evals.mjs";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, digest, save } from "../scripts/lib/skill-evidence.mjs";
import { cases } from "./evals/cases.mjs";

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
