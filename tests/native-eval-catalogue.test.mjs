import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, save } from "../scripts/lib/skill-evidence.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exporter = join(repository, "scripts/export-eval-catalogue.mjs");
const evaluator = join(repository, "scripts/evaluate-skills.mjs");
// Bun runs the test suite too, but exporting always uses the real Node runtime.
const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
const version = execFileSync(node, ["-p", "process.versions.node"], { encoding: "utf8" }).trim().split(".").map(Number);
const supportedNode = version[0] > 22 || (version[0] === 22 && version[1] >= 13);
const candidateCase = { id: "candidate-new-case", skill: "qa", unchanged: true,
  files: { "request.txt": "Report only.\n" }, prompt: "Read request.txt and report only.", rubric: ["The source remains unchanged."] };
const catalogue = { cases: [candidateCase], variants: { supportive: "Be careful.", neutral: "", competing: "Be brief.", "candidate-new-variant": "A candidate-only condition." } };
const exportsSource = `export const cases = ${JSON.stringify(catalogue.cases)};\nexport const variants = ${JSON.stringify(catalogue.variants)};\n`;

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "supermatt-catalogue-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t, source = exportsSource) {
  const root = scratch(t), snapshot = join(root, "snapshot"), output = join(root, "catalogue.json");
  mkdirSync(join(snapshot, "tests/evals"), { recursive: true });
  writeFileSync(join(snapshot, "tests/evals/cases.mjs"), source);
  return { root, snapshot, output };
}

function exportCatalogue(input, options = {}) {
  return spawnSync(node, [exporter, input.snapshot, input.output], { cwd: repository, encoding: "utf8", timeout: 15000, ...options });
}

function denied(result, output, diagnostic) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, diagnostic);
  assert.equal(existsSync(output), false, "no partial catalogue is published");
}

test("export preserves candidate-only cases, variants and same-snapshot imports as JSON", { skip: !supportedNode }, t => {
  const input = fixture(t, `import { sample } from './sample.mjs';\nexport const cases = [sample];\nexport const variants = ${JSON.stringify(catalogue.variants)};\n`);
  writeFileSync(join(input.snapshot, "tests/evals/sample.mjs"), `export const sample = ${JSON.stringify(candidateCase)};\n`);
  const result = exportCatalogue(input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(input.output, "utf8")), catalogue);
  assert.equal(result.stdout, "", "the catalogue is written only to its explicit output file");
});

test("candidate export receives no inherited operator environment", { skip: !supportedNode }, t => {
  // macOS adds __CF_USER_TEXT_ENCODING to every process it starts, even with an empty environment; it is not operator data.
  const input = fixture(t, `if (Object.keys(process.env).some(key => key !== '__CF_USER_TEXT_ENCODING')) throw Error('operator environment leaked');\n${exportsSource}`);
  const result = exportCatalogue(input, { env: { ...process.env, NATIVE_EVAL_OPERATOR_SECRET: "must-not-reach-candidate" } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(input.output, "utf8")).cases, [candidateCase]);
});

test("candidate cannot read a file outside its snapshot", { skip: !supportedNode }, t => {
  const input = fixture(t);
  const secret = join(input.root, "operator-secret.txt"); writeFileSync(secret, "private\n");
  writeFileSync(join(input.snapshot, "tests/evals/cases.mjs"), `import { readFileSync } from 'node:fs';\nreadFileSync(${JSON.stringify(secret)});\n${exportsSource}`);
  denied(exportCatalogue(input), input.output, /ERR_ACCESS_DENIED|FileSystemRead/);
});

test("candidate cannot launch a child process", { skip: !supportedNode }, t => {
  const input = fixture(t, `import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, ['-e', 'process.exit(0)']);\n${exportsSource}`);
  denied(exportCatalogue(input), input.output, /ERR_ACCESS_DENIED|ChildProcess/);
});

test("candidate cannot write even inside its readable snapshot", { skip: !supportedNode }, t => {
  const input = fixture(t, `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./unauthorized.txt', import.meta.url), 'changed');\n${exportsSource}`);
  denied(exportCatalogue(input), input.output, /ERR_ACCESS_DENIED|FileSystemWrite/);
  assert.equal(existsSync(join(input.snapshot, "tests/evals/unauthorized.txt")), false);
});

for (const [name, source, diagnostic] of [
  ["worker threads", `import { Worker } from 'node:worker_threads';\nnew Worker('process.exit(0)', { eval: true });`, /ERR_ACCESS_DENIED|WorkerThreads/],
  ["native addons", "process.dlopen({}, '/not-a-real-addon.node');", /ERR_DLOPEN_DISABLED|ERR_ACCESS_DENIED|addons|restricted/],
  ["WASI", `import { WASI } from 'node:wasi';\nnew WASI({ version: 'preview1', args: [], env: {} });`, /ERR_ACCESS_DENIED|WASI|restricted/],
]) {
  test(`candidate receives no permission for ${name}`, { skip: !supportedNode }, t => {
    const input = fixture(t, `${source}\n${exportsSource}`);
    denied(exportCatalogue(input), input.output, diagnostic);
  });
}

test("snapshot symlink escapes are rejected before any candidate code is imported", { skip: !supportedNode }, t => {
  const input = fixture(t, `throw Error('candidate was imported before symlink rejection');\n${exportsSource}`);
  const outside = join(input.root, "outside.mjs"); writeFileSync(outside, exportsSource);
  symlinkSync(outside, join(input.snapshot, "escape.mjs"));
  const result = exportCatalogue(input);
  denied(result, input.output, /symlink/i);
  assert.doesNotMatch(result.stderr, /candidate was imported/);
});

test("a symlinked snapshot root is rejected", { skip: !supportedNode }, t => {
  const input = fixture(t), alias = join(input.root, "alias");
  symlinkSync(input.snapshot, alias);
  denied(exportCatalogue({ ...input, snapshot: alias }), input.output, /symlink/i);
});

for (const [name, expression] of [
  ["functions", "() => 1"], ["bigints", "1n"], ["undefined", "undefined"], ["symbols", "Symbol('value')"],
  ["nonfinite numbers", "NaN"], ["infinite numbers", "Infinity"], ["class instances", "new (class Sample {})()"],
  ["dates", "new Date(0)"], ["circular objects", "(() => { const x = {}; x.self = x; return x; })()"],
  ["sparse arrays", "Array(2)"], ["getters", "({ get value() { throw Error('getter ran'); } })"],
  ["proxies", "new Proxy({}, {})"], ["boxed primitives", "new String('value')"],
  ["array properties", "Object.assign([], { hidden: 'must not disappear' })"],
  ["symbol properties", "({ [Symbol('hidden')]: true })"],
  ["hidden properties", "Object.defineProperty({}, 'hidden', { value: true })"],
  ["custom toJSON", "({ toJSON() { return 'silently replaced'; } })"],
]) {
  test(`export rejects ${name} rather than dropping or converting them`, { skip: !supportedNode }, t => {
    const input = fixture(t, `${exportsSource}\ncases[0].extra = ${expression};\n`);
    denied(exportCatalogue(input), input.output, /Invalid evaluation catalogue/);
  });
}

for (const [name, change] of [
  ["duplicate case identifiers", "cases.push(cases[0]);"],
  ["case path traversal", "cases[0].id = '../escape';"],
  ["skill path traversal", "cases[0].skill = '../escape';"],
  ["fixture path traversal", "cases[0].files = { '../outside': 'changed' };"],
  ["absolute fixture paths", "cases[0].files = { '/outside': 'changed' };"],
  ["Git metadata writes", "cases[0].files = { '.git/config': 'changed' };"],
  ["nested Git metadata", "cases[0].files = { 'nested/.git/config': 'changed' };"],
  ["case-folded Git metadata", "cases[0].files = { '.GIT/hooks/pre-commit': 'changed' };"],
  ["required file traversal", "cases[0].requiredFile = '../outside';"],
  ["variant path traversal", "variants['../escape'] = '';"],
]) {
  test(`export rejects ${name} before the evaluator consumes the data`, { skip: !supportedNode }, t => {
    const input = fixture(t, `${exportsSource}\n${change}\n`);
    denied(exportCatalogue(input), input.output, /Invalid evaluation catalogue/);
  });
}

test("candidate stdout cannot add non-JSON catalogue output", { skip: !supportedNode }, t => {
  const input = fixture(t, `console.log('not catalogue JSON');\n${exportsSource}`);
  denied(exportCatalogue(input), input.output, /JSON|Unexpected token/);
});

test("export stops a candidate that never returns within five seconds", { skip: !supportedNode, timeout: 15000 }, t => {
  const input = fixture(t, "while (true) {}\n");
  denied(exportCatalogue(input), input.output, /timed out/);
});

for (const stream of ["stdout", "stderr"]) {
  test(`export caps total candidate ${stream} at 4 MiB`, { skip: !supportedNode }, t => {
    const input = fixture(t, `process.${stream}.write('x'.repeat(4 * 1024 * 1024 + 1));\nawait new Promise(() => {});\n`);
    denied(exportCatalogue(input), input.output, /output limit exceeded/);
  });
}

function candidateRepository(t) {
  const repo = join(scratch(t), "repo"); mkdirSync(repo);
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[name];
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [path, body] of Object.entries({
    ".claude-plugin/plugin.json": '{"name":"supermatt"}',
    ".agents/plugins/marketplace.json": '{"name":"supermatt","plugins":[{"name":"supermatt"}]}',
    ".cursor-plugin/plugin.json": '{"name":"supermatt"}',
    "skills/qa/SKILL.md": "---\nname: qa\n---\n",
    "skills/qa/agents/openai.yaml": "policy:\n  allow_implicit_invocation: true\n",
    // The trusted evaluator must never execute the candidate's bundled script
    // or import its catalogue, even when freezing both arms of the comparison.
    "scripts/evaluate-skills.mjs": "throw Error('untrusted evaluator executed');\n",
    "tests/evals/cases.mjs": "throw Error('untrusted catalogue imported in parent');\n",
  })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), body);
  }
  git("add", "."); git("commit", "-qm", "candidate");
  return { repo, sha: git("rev-parse", "HEAD"), env };
}

test("a candidate-only case and variant flow through trusted evaluator --dry-run", { skip: !supportedNode }, t => {
  const input = fixture(t), { repo, sha, env } = candidateRepository(t);
  const exported = exportCatalogue(input); assert.equal(exported.status, 0, exported.stderr);
  const result = spawnSync(process.execPath, [evaluator, "--catalogue", input.output, "--model", "test", "--repo", repo,
    "--baseline", sha, "--candidate", sha, "--cases", candidateCase.id, "--variants", "candidate-new-variant", "--runs", "1", "--dry-run"],
    { cwd: repository, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.cases, ["candidate-new-case"]);
  assert.deepEqual(plan.variants, ["candidate-new-variant"]);
  assert.equal(plan.plannedRuns, 2);
});

test("a run with a bare candidate repository records no working-tree status and freezes both arms", t => {
  const { repo, sha, env } = candidateRepository(t), root = scratch(t), bare = join(root, "candidate.git");
  execFileSync("git", ["clone", "--bare", "--quiet", repo, bare], { env });
  execFileSync("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/unborn-default"], { env });
  const cataloguePath = join(root, "catalogue.json"); save(cataloguePath, catalogue);
  const codex = join(root, "codex.cjs");
  writeFileSync(codex, "#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('catalogue test control'); else process.exit(1);\n", { mode: 0o700 });
  const result = spawnSync(process.execPath, [evaluator, "--catalogue", cataloguePath, "--model", "test", "--repo", bare,
    "--baseline", sha, "--candidate", sha, "--cases", candidateCase.id, "--variants", "neutral", "--runs", "1", "--codex", codex],
    { cwd: repository, env: { ...env, TMPDIR: root }, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(result.stdout), report = JSON.parse(readFileSync(join(summary.evidence, "report.json"), "utf8"));
  assert.equal(report.sourceStatus, null);
  assert.equal(report.sourceHead, sha, "the candidate SHA, not the bare origin HEAD, identifies the source");
  assert.equal(report.snapshots.baseline.revision, sha);
  assert.equal(report.snapshots.candidate.revision, sha);
  assert.equal(summary.startedRuns, 0);
});

test("a blocked run retains the exact loaded catalogue and its digest in harness artifacts", t => {
  const root = scratch(t), path = join(root, "input.json");
  const bytes = "  " + JSON.stringify(catalogue, null, 2) + "\n\n"; writeFileSync(path, bytes);
  const result = spawnSync(process.execPath, [evaluator, "--catalogue", path, "--model", "test", "--baseline", "HEAD",
    "--cases", candidateCase.id, "--variants", "neutral", "--runs", "1", "--codex", join(root, "missing-codex")],
    { cwd: repository, encoding: "utf8", env: { ...process.env, TMPDIR: root } });
  assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(result.stdout), report = JSON.parse(readFileSync(join(summary.evidence, "report.json"), "utf8"));
  assert.equal(summary.startedRuns, 0);
  assert.equal(readFileSync(join(summary.evidence, "harness/catalogue.json"), "utf8"), bytes);
  assert.equal(report.catalogueDigest, digest(bytes));
  assert.equal(report.harnessFiles["catalogue.json"], digest(bytes));
});

function adjudication(t) {
  const root = scratch(t), harness = join(root, "harness"); mkdirSync(harness);
  const path = join(harness, "catalogue.json"), bytes = JSON.stringify(catalogue) + "\n"; writeFileSync(path, bytes);
  const skill = { path: "/plugin/skills/qa/SKILL.md", body: "SKILL CONTENT\n" };
  const events = [
    { type: "item.completed", item: { type: "command_execution", command: `cat ${skill.path}`, exit_code: 0, aggregated_output: skill.body } },
    { type: "item.completed", item: { type: "agent_message", text: "Evidence report" } }, { type: "turn.completed" },
  ];
  const trace = events.map(event => JSON.stringify(event)).join("\n") + "\n", results = [], reviews = [];
  for (const arm of ["baseline", "candidate"]) {
    const id = `${arm}-${candidateCase.id}-candidate-new-variant-1`, directory = join(root, id); mkdirSync(directory);
    writeFileSync(join(directory, "trace.jsonl"), trace);
    save(join(directory, "observation.json"), { skill, before: candidateCase.files, after: candidateCase.files,
      process: { code: 0 }, traceDigest: digest(trace) });
    const evidenceDigest = digest(readFileSync(join(directory, "observation.json")));
    results.push({ id, status: "needs review", evidenceDigest });
    reviews.push({ id, evidenceDigest, verdict: "pass", reviewer: "test control", rationale: "The source is unchanged.", evidence: [`${id}/observation.json:1`] });
  }
  save(join(root, "report.json"), { plannedRuns: 2, completedRuns: 2, catalogueDigest: digest(bytes), harnessFiles: { "catalogue.json": digest(bytes) }, results });
  save(join(root, "reviews.json"), reviews);
  const invoke = (...extra) => spawnSync(process.execPath, [evaluator, "--adjudicate", root, "--reviews", join(root, "reviews.json"), ...extra], { cwd: repository, encoding: "utf8" });
  return { root, path, invoke };
}

test("adjudication uses the saved candidate catalogue, including a new variant, without importing saved JavaScript", t => {
  const input = adjudication(t), source = join(input.root, "harness/tests/evals/cases.mjs");
  mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, "throw Error('saved candidate JavaScript executed');\n");
  const result = input.invoke(); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(join(input.root, "adjudicated-report.json"), "utf8"));
  assert.equal(report.status, "pass");
  assert.ok(report.results.every(result => result.status === "pass"));
});

test("adjudication fails clearly if the retained catalogue changed", t => {
  const input = adjudication(t); writeFileSync(input.path, JSON.stringify({ ...catalogue, variants: { neutral: "changed" } }));
  const result = input.invoke(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Saved catalogue changed/);
  assert.equal(existsSync(join(input.root, "adjudicated-report.json")), false);
});

test("adjudication fails clearly if the retained catalogue is missing", t => {
  const input = adjudication(t); rmSync(input.path);
  const result = input.invoke(); assert.notEqual(result.status, 0); assert.match(result.stderr, /catalogue\.json|catalogue.*missing/i);
});

test("adjudication rejects a --catalogue that differs from the saved harness", t => {
  const input = adjudication(t), other = join(input.root, "other.json");
  writeFileSync(other, JSON.stringify({ ...catalogue, variants: { neutral: "changed" } }));
  const result = input.invoke("--catalogue", other); assert.notEqual(result.status, 0); assert.match(result.stderr, /differs from the saved catalogue/);
});

test("adjudication rejects inconsistent catalogue integrity metadata", t => {
  const input = adjudication(t), reportPath = join(input.root, "report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  report.harnessFiles["catalogue.json"] = "0".repeat(64); save(reportPath, report);
  const result = input.invoke(); assert.notEqual(result.status, 0); assert.match(result.stderr, /integrity metadata/);
});

test("legacy adjudication fails clearly when the trusted default corpus does not match", t => {
  const root = scratch(t);
  save(join(root, "report.json"), { results: [], harnessFiles: { "tests/evals/cases.mjs": "not-the-current-corpus" } });
  save(join(root, "reviews.json"), []);
  const result = spawnSync(process.execPath, [evaluator, "--adjudicate", root, "--reviews", join(root, "reviews.json")], { cwd: repository, encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Corpus changed/);
});

test("evaluator --catalogue rejects fixture escapes even without the exporter", t => {
  const root = scratch(t), path = join(root, "invalid.json");
  save(path, { cases: [{ ...candidateCase, files: { "../outside": "unauthorized" } }], variants: catalogue.variants });
  const result = spawnSync(process.execPath, [evaluator, "--catalogue", path, "--model", "test", "--baseline", "HEAD", "--dry-run"], { cwd: repository, encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid evaluation catalogue/); assert.equal(result.stdout, "");
  assert.equal(existsSync(join(root, "outside")), false);
});
