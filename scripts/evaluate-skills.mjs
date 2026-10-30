#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { cases, variants } from "../tests/evals/cases.mjs";
import { digest, installPlugin, listSkills, manifest, privateEnvironment, project, run, save, snapshot, verifyDiscovery } from "./lib/skill-evidence.mjs";
import { absentResult, collectState, comparisonStatus, grade, parseTrace, planComparison, redact, reviewResults, selectCases } from "./lib/skill-evals.mjs";
import { readCatalogue } from "./export-eval-catalogue.mjs";

const { values } = parseArgs({ options: {
  model: { type: "string" }, baseline: { type: "string" }, candidate: { type: "string", default: "working" },
  repo: { type: "string", default: "." }, codex: { type: "string", default: "codex" },
  cases: { type: "string" }, variants: { type: "string", default: "supportive,neutral,competing" },
  runs: { type: "string", default: "3" }, timeout: { type: "string", default: "300" },
  "dry-run": { type: "boolean" }, adjudicate: { type: "string" }, reviews: { type: "string" }, catalogue: { type: "string" },
} });

// The only variables a model's shell receives. The preflight probe runs its
// commands with the same set, so its Git positive control matches a run.
const shellEnvironment = ({ temp, toolchain }) => ({ PATH: toolchain.path, HOME: temp, TMPDIR: temp, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", OPENSSL_CONF: "/dev/null" });

function configuration({ cwd, plugin, runtime, temp, toolchain }) {
  const q = JSON.stringify;
  const disabled = ["apps", "hooks", "memories", "multi_agent", "remote_plugin", "shell_snapshot", "skill_mcp_dependency_install",
    "browser_use", "browser_use_external", "computer_use", "image_generation", "in_app_browser", "in_app_local_automation"];
  return `\napproval_policy = "never"\nweb_search = "disabled"\nallow_login_shell = false\nmodel_reasoning_effort = "medium"\n` +
    `default_permissions = "skill-eval"\nproject_doc_max_bytes = 0\n` +
    `[shell_environment_policy]\ninherit = "none"\n[shell_environment_policy.set]\n` +
    Object.entries(shellEnvironment({ temp, toolchain })).map(([name, value]) => `${name} = ${q(value)}`).join("\n") + "\n" +
    `[features]\n${disabled.map(name => `${name} = false`).join("\n")}\n` +
    `[permissions.skill-eval.filesystem]\n":minimal" = "read"\n${q(cwd)} = "write"\n${q(join(cwd, ".git"))} = "write"\n${q(plugin)} = "read"\n${q(temp)} = "write"\n` +
    [...new Set([dirname(runtime), ...toolchain.roots])].map(path => `${q(path)} = "read"`).join("\n") + "\n" +
    `[permissions.skill-eval.network]\nenabled = false\n`;
}

async function preflight(codex, options, fixture, forbidden, runtime, shell) {
  const server = createServer(socket => socket.end());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    // Establish the positive control first. Seatbelt can surface its denial as
    // ECONNREFUSED rather than EPERM; a missing listener must not pass this test.
    await new Promise((resolve, reject) => {
      const socket = connect(server.address().port, "127.0.0.1");
      socket.on("connect", () => { socket.destroy(); resolve(); }); socket.on("error", reject);
    });
    const probe = join(fixture, ".isolation-probe.mjs"), git = { cwd: fixture, env: options.env };
    try {
      // Give the fixture its own repository, as each run does, so the probe can
      // prove the profile lets a sandboxed command commit in it.
      await run("git", ["init", "-q", "-b", "preflight"], git);
      await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "preflight"], git);
      writeFileSync(probe, `import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {connect} from 'node:net';
const shell = { env: ${JSON.stringify(shell)}, encoding: 'utf8' };
execFileSync('git',['--version'],shell);
execFileSync('node',['-e','console.log(42)'],shell);
for (const path of ${JSON.stringify(forbidden)}) {
  let denied = false;
  try { readFileSync(path); } catch(e) { denied = ['EPERM','EACCES'].includes(e.code); }
  if (!denied) throw Error('Read boundary not enforced');
  denied = false;
  try { writeFileSync(path, 'probe'); } catch(e) { denied = ['EPERM','EACCES'].includes(e.code); }
  if (!denied) throw Error('Write boundary not enforced');
}
writeFileSync('allowed-probe','ok');
execFileSync('git',['add','--','allowed-probe'],shell);
execFileSync('git',['-c','user.name=Probe','-c','user.email=probe@example.invalid','-c','commit.gpgsign=false','commit','-q','-m','probe'],shell);
if (execFileSync('git',['log','-1','--format=%s'],shell).trim() !== 'probe') throw Error('Fixture commit not recorded');
unlinkSync('allowed-probe');
await new Promise((resolve,reject) => {
  const socket=connect(${server.address().port},'127.0.0.1');
  socket.setTimeout(3000,()=>{socket.destroy();reject(Error('Network probe inconclusive'));});
  socket.on('connect',()=>{socket.destroy();reject(Error('Network boundary not enforced'));});
  socket.on('error',e=>['EPERM','EACCES','ECONNREFUSED'].includes(e.code)?resolve():reject(e));
});
console.log('isolation verified');\n`);
      const output = await run(codex, ["sandbox", "-P", "skill-eval", "-C", fixture, runtime, probe], options);
      assert.match(output, /isolation verified/);
      return { status: "pass", boundary: "native command sandbox: denied read/write and live loopback connection; allowed fixture write, fixture Git commit and Node runtime" };
    } finally { rmSync(probe, { force: true }); rmSync(join(fixture, ".git"), { recursive: true, force: true }); }
  } finally { await new Promise(resolve => server.close(resolve)); }
}

// Returns the fixture commit, so a run's own commits can be told apart from it.
async function initializeFixture(root, testCase, env) {
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(testCase.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content);
  }
  const options = { cwd: root, env };
  await run("git", ["init", "-q", "-b", "fixture"], options);
  await run("git", ["add", "."], options);
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], options);
  if (testCase.id === "handoff") writeFileSync(join(root, "draft.txt"), "changed uncommitted user work\n");
  return (await run("git", ["rev-parse", "HEAD"], options)).trim();
}

// After a model run, its repository configuration is model-written, and Git executes parts of it
// (core.fsmonitor, filter drivers). Read it only through the same sandbox and shell environment.
const sandboxedGit = (codex, { cwd, shell, codexHome }, args) =>
  run(codex, ["sandbox", "-P", "skill-eval", "-C", cwd, "git", ...args], { cwd, env: { ...shell, CODEX_HOME: codexHome } });

// Freezes both arms, including an uncommitted candidate, into installable carriers under
// `work`, and returns each arm's manifest. Only the candidate ships, so only it must pass the
// package manifest checks: a baseline release can predate a manifest required today.
async function freeze(repo, work) {
  const manifests = {};
  for (const [arm, revision] of [["baseline", values.baseline], ["candidate", values.candidate]]) {
    const source = join(work, `${arm}-source`), carrier = join(work, `${arm}-carrier`);
    await snapshot(repo, revision, source); project(source, carrier);
    manifests[arm] = manifest(carrier, { packaging: arm === "candidate" });
    rmSync(source, { recursive: true });
  }
  return manifests;
}

const skillSets = manifests => Object.fromEntries(Object.entries(manifests).map(([arm, m]) => [arm, new Set(m.skills.map(s => s.name))]));

function adjudicationCatalogue(root, report) {
  if (report.catalogueDigest || report.harnessFiles?.["catalogue.json"]) {
    assert.ok(report.catalogueDigest && report.harnessFiles?.["catalogue.json"] === report.catalogueDigest, "Saved catalogue integrity metadata is missing or inconsistent");
    const loaded = readCatalogue(join(root, "harness/catalogue.json"));
    assert.equal(digest(loaded.bytes), report.catalogueDigest, "Saved catalogue changed");
    if (values.catalogue) assert.equal(digest(readCatalogue(values.catalogue).bytes), report.catalogueDigest, "--catalogue differs from the saved catalogue");
    return loaded.data;
  }
  assert.ok(!values.catalogue, "This report has no saved catalogue; use the matching trusted corpus and evaluator or rerun");
  const corpusPath = fileURLToPath(new URL("../tests/evals/cases.mjs", import.meta.url));
  assert.equal(report.harnessFiles?.["tests/evals/cases.mjs"], digest(readFileSync(corpusPath)), "Corpus changed; use the matching corpus and evaluator or rerun");
  return { cases, variants };
}

async function main() {
  if (values.adjudicate) {
    assert.ok(values.reviews, "--reviews is required with --adjudicate");
    const root = realpathSync(values.adjudicate);
    const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
    const reviews = JSON.parse(readFileSync(values.reviews, "utf8"));
    const catalogue = adjudicationCatalogue(root, report);
    for (const result of report.results) {
      if (!result.evidenceDigest) continue;
      const bytes = readFileSync(join(root, result.id, "observation.json"));
      assert.equal(digest(bytes), result.evidenceDigest, "Saved evidence changed");
      const observation = JSON.parse(bytes);
      const trace = readFileSync(join(root, result.id, "trace.jsonl"), "utf8");
      assert.equal(digest(trace), observation.traceDigest, "Saved trace changed");
      const matches = catalogue.cases.filter(c => Object.keys(catalogue.variants).some(condition =>
        new RegExp(`^(baseline|candidate)-${c.id}-${condition}-[1-9]\\d*$`).test(result.id)));
      assert.equal(matches.length, 1, "Unknown or ambiguous case in report");
      const [testCase] = matches;
      let checked;
      try {
        checked = observation.captureErrors?.length ? { status: "blocked", findings: observation.captureErrors }
          : grade(testCase, { ...observation, events: parseTrace(trace) });
      } catch (error) { checked = { status: "blocked", findings: [error.message] }; }
      if (["blocked", "fail"].includes(checked.status)) Object.assign(result, checked);
    }
    for (const review of reviews) for (const pointer of review.evidence ?? []) {
      const path = resolve(root, pointer.replace(/:\d+$/, ""));
      assert.ok(path.startsWith(root + "/") && existsSync(path), "Evidence pointer missing or outside report");
    }
    report.graderDigest = digest(readFileSync(fileURLToPath(new URL("./lib/skill-evals.mjs", import.meta.url))));
    report.results = reviewResults(report.results, reviews);
    report.status = comparisonStatus(report);
    save(join(root, "adjudicated-report.json"), report);
    console.log(JSON.stringify({ status: report.status, evidence: root }));
    if (report.status !== "pass") process.exitCode = 1;
    return;
  }
  assert.ok(values.model && values.baseline, "--model and --baseline are required");
  const loaded = values.catalogue ? readCatalogue(values.catalogue)
    : { data: { cases, variants }, bytes: Buffer.from(JSON.stringify({ cases, variants }) + "\n") };
  const { cases: activeCases, variants: activeVariants } = loaded.data;
  const repetitions = Number(values.runs), timeout = Number(values.timeout) * 1000;
  assert.ok(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 10, "--runs must be 1..10");
  assert.ok(Number.isFinite(timeout) && timeout >= 1000 && timeout <= 300000, "--timeout must be 1..300 seconds");
  const selected = selectCases(activeCases, values.cases), conditions = values.variants.split(",");
  assert.ok(new Set(conditions).size === conditions.length && conditions.every(v => Object.hasOwn(activeVariants, v)), "Unknown or duplicate variant");
  if (values["dry-run"]) {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "supermatt-evals-plan-")));
    let plan;
    try { plan = planComparison(selected, skillSets(await freeze(realpathSync(values.repo), scratch)), { conditions, repetitions }); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
    console.log(JSON.stringify({ model: values.model, cases: selected.map(c => c.id), variants: conditions, repetitions, plannedRuns: plan.plannedRuns,
      baselineAbsent: plan.absent, maxSecondsPerRun: timeout / 1000, baseline: values.baseline, candidate: values.candidate,
      note: "Counts CLI runs, not provider requests. One run can make multiple requests. A case whose skill the baseline lacks runs only in the candidate. No price estimate; token use and provider pricing vary." }, null, 2));
    return;
  }
  const evidence = realpathSync(mkdtempSync(join(tmpdir(), "supermatt-evals-")));
  const work = join(evidence, "work"); mkdirSync(work);
  const report = { status: "blocked", requestedModel: values.model, reportedModel: null, reasoningEffort: "medium", plannedRuns: null,
    startedRuns: 0, providerRequests: null, claude: "unavailable", corpusDigest: digest(JSON.stringify({ selected, variants: activeVariants })),
    catalogueDigest: digest(loaded.bytes), results: [], snapshots: {} };
  const secrets = [];
  const safeSave = (path, value) => writeFileSync(path, redact(JSON.stringify(value, null, 2) + "\n", secrets), { mode: 0o600 });
  try {
    const harness = join(evidence, "harness"); mkdirSync(harness);
    report.harnessFiles = {};
    for (const path of ["scripts/evaluate-skills.mjs", "scripts/export-eval-catalogue.mjs", "scripts/lib/skill-evidence.mjs", "scripts/lib/skill-evals.mjs", "tests/evals/cases.mjs"]) {
      const source = resolve(dirname(fileURLToPath(import.meta.url)), "..", path);
      mkdirSync(dirname(join(harness, path)), { recursive: true }); cpSync(source, join(harness, path));
      report.harnessFiles[path] = digest(readFileSync(source));
    }
    writeFileSync(join(harness, "catalogue.json"), loaded.bytes, { mode: 0o600 });
    report.harnessFiles["catalogue.json"] = report.catalogueDigest;
    const repo = realpathSync(values.repo), runtime = realpathSync(process.execPath);
    const codex = values.codex.includes("/") ? resolve(values.codex) : (await run("which", [values.codex])).trim();
    const bin = join(work, "bin"); mkdirSync(bin);
    const git = (await run(process.platform === "darwin" ? "xcrun" : "which", process.platform === "darwin" ? ["--find", "git"] : ["git"])).trim();
    const node = (await run("node", ["-p", "process.execPath"])).trim();
    for (const [name, executable] of [["git", git], ["node", node], [process.versions.bun ? "bun" : "node-runtime", runtime]]) symlinkSync(executable, join(bin, name));
    const toolchain = { path: `${bin}:/usr/bin:/bin`, roots: [bin, dirname(realpathSync(git)), dirname(realpathSync(node))] };
    report.toolchain = { git, node, runtime };
    report.cli = (await run(codex, ["--version"])).trim();
    const bare = (await run("git", ["-C", repo, "rev-parse", "--is-bare-repository"])).trim() === "true";
    report.sourceHead = (await run("git", ["-C", repo, "rev-parse", bare ? `${values.candidate}^{commit}` : "HEAD"])).trim();
    report.sourceStatus = bare ? null : await run("git", ["-C", repo, "status", "--porcelain"]);
    // Freeze both arms before the first model call, including an uncommitted
    // candidate. Editing the checkout during a long run cannot change its arm.
    // The selected corpus is checked against both before any run starts.
    const manifests = await freeze(repo, work);
    for (const [arm, revision] of [["baseline", values.baseline], ["candidate", values.candidate]]) {
      report.snapshots[arm] = { revision, digest: manifests[arm].digest };
      safeSave(join(evidence, `${arm}-manifest.json`), manifests[arm]);
    }
    const plan = planComparison(selected, skillSets(manifests), { conditions, repetitions });
    Object.assign(report, { plannedRuns: plan.plannedRuns, absentRuns: plan.absentRuns, baselineAbsent: plan.absent });
    // Only the parent CLI can access the existing native auth link. No auth
    // bytes are placed in the fixture or granted to model tools.
    const auth = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    if (existsSync(auth)) {
      const collect = value => { if (typeof value === "string" && value.length > 16) secrets.push(value); else if (value && typeof value === "object") Object.values(value).forEach(collect); };
      collect(JSON.parse(readFileSync(auth, "utf8")));
    }
    for (const [arm, revision] of [["baseline", values.baseline], ["candidate", values.candidate]]) {
      const carrier = join(work, `${arm}-carrier`), expected = manifests[arm];
      const home = join(work, `${arm}-home`), env = privateEnvironment(home), cwd = join(work, `${arm}-fixture`);
      mkdirSync(cwd);
      await installPlugin(codex, carrier, { cwd, env });
      const observed = await listSkills(codex, { cwd, env });
      const installed = verifyDiscovery(observed, expected, env.CODEX_HOME);
      rmSync(carrier, { recursive: true });
      const temp = join(home, "tmp"), settings = configuration({ cwd, plugin: installed.root, runtime, temp, toolchain });
      // plugin add writes its own TOML tables. Place root settings before them.
      const configPath = join(env.CODEX_HOME, "config.toml");
      writeFileSync(configPath, settings + "\n" + readFileSync(configPath, "utf8"));
      const configured = await listSkills(codex, { cwd, env }, true);
      const capabilities = configured.configuration;
      assert.deepEqual(capabilities.mcpServers, [], "Unrelated MCP servers are enabled");
      assert.equal(capabilities.webSearch, "disabled", "Web search was not disabled");
      assert.equal(capabilities.defaultPermissions, "skill-eval", "Evaluation permission profile is not active");
      for (const feature of ["apps", "hooks", "memories", "multi_agent", "browser_use", "computer_use"]) {
        assert.equal(capabilities.features?.[feature], false, `${feature} was not disabled`);
      }
      report.capabilities = capabilities;
      const forbidden = [join(work, "grader-canary"), join(home, "auth-canary")];
      for (const path of forbidden) writeFileSync(path, "synthetic canary\n");
      report.isolation = await preflight(codex, { cwd, env: { ...env, PATH: toolchain.path, OPENSSL_CONF: "/dev/null" } }, cwd, forbidden, runtime, shellEnvironment({ temp, toolchain }));
      if (existsSync(auth)) symlinkSync(auth, join(env.CODEX_HOME, "auth.json"));
      else if (process.env.OPENAI_API_KEY) { env.OPENAI_API_KEY = process.env.OPENAI_API_KEY; secrets.push(env.OPENAI_API_KEY); }
      else throw new Error("Native Codex auth is unavailable; no model calls started");
      for (const c of selected) for (const condition of conditions) for (let repetition = 1; repetition <= repetitions; repetition++) {
        const id = `${arm}-${c.id}-${condition}-${repetition}`;
        if (arm === "baseline" && plan.absent.includes(c.id)) {
          report.results.push(absentResult(id));
          report.completedRuns = report.results.length;
          report.status = comparisonStatus(report); safeSave(join(evidence, "report.json"), report);
          console.log(`${id}: absent`);
          continue;
        }
        const out = join(evidence, id); mkdirSync(out);
        rmSync(cwd, { recursive: true }); const fixtureCommit = await initializeFixture(cwd, c, env);
        rmSync(temp, { recursive: true }); mkdirSync(temp);
        const skill = { path: join(installed.root, "skills", c.skill, "SKILL.md") };
        skill.body = readFileSync(skill.path, "utf8");
        const prompt = `Use $${c.skill}. First, read the full skill at ${skill.path} with one cat command before doing any work.\n${c.prompt}\n${activeVariants[condition]}\nThis is a scoped synthetic fixture. Available files are in the working directory. Only the requested fixture work is authorized.\n`;
        const initial = collectState(cwd); assert.deepEqual(initial.errors, [], "Fixture capture failed");
        const before = initial.state, start = Date.now();
        const args = ["exec", "--strict-config", "--ignore-rules", "--ephemeral", "--json", "--skip-git-repo-check", "--model", values.model, "--cd", cwd, "-"];
        let output = "", processResult = { code: 0 }, result;
        report.startedRuns++;
        try { output = await run(codex, args, { cwd, env, input: prompt, timeout }); }
        catch (error) { output = error.stdout || ""; processResult = { code: error.code ?? null, timedOut: !!error.timedOut, error: redact(error.message, secrets) }; }
        const redactedTrace = redact(output, secrets);
        writeFileSync(join(out, "trace.jsonl"), redactedTrace, { mode: 0o600 });
        let events = [];
        try { events = parseTrace(output); }
        catch (error) { result = { status: "blocked", findings: [error.message, processResult.error].filter(Boolean) }; }
        const durationMs = Date.now() - start, gitState = {}, gitErrors = [];
        const captured = collectState(cwd), temporary = collectState(temp);
        // Git runs model-written configuration (such as core.fsmonitor) that can change files, so
        // the run is graded on the state captured before these reads, and any change they make
        // blocks it. The log keeps commits a reset dropped (--reflog) and the paths a merge
        // resolution changed (--diff-merges=first-parent).
        const repository = { cwd, shell: shellEnvironment({ temp, toolchain }), codexHome: env.CODEX_HOME };
        try {
          gitState.gitStatus = await sandboxedGit(codex, repository, ["status", "--porcelain"]);
          gitState.gitCommits = await sandboxedGit(codex, repository, ["log", "--all", "--reflog", "--diff-merges=first-parent", "--format=%H %s", "--name-status", "--not", fixtureCommit]);
        } catch (error) { gitErrors.push(`Git state unavailable: ${error.message}`); }
        if (!isDeepStrictEqual([captured, temporary], [collectState(cwd), collectState(temp)])) gitErrors.push("Fixture or artifacts changed while Git state was read");
        const captureErrors = [...captured.errors, ...temporary.errors, ...gitErrors];
        const observation = { events, skill, fixtureRoot: cwd, before, after: captured.state, artifacts: temporary.state, captureErrors,
          traceDigest: digest(redactedTrace), process: processResult, prompt, durationMs,
          settingsDigest: digest(settings), ...gitState };
        if (captureErrors.length) result = { status: "blocked", findings: captureErrors };
        result ??= grade(c, observation);
        safeSave(join(out, "observation.json"), observation);
        const model = events.find(e => e.model)?.model;
        if (model) report.reportedModel = model;
        report.results.push({ id, ...result, rubric: c.rubric, evidenceDigest: digest(readFileSync(join(out, "observation.json"))) });
        report.completedRuns = report.results.length;
        report.status = comparisonStatus(report); safeSave(join(evidence, "report.json"), report);
        console.log(`${id}: ${result.status}`);
        if (result.status === "blocked") throw new Error(`Stopped after blocked run ${id}; remaining runs are unobserved`);
      }
    }
    report.status = comparisonStatus(report);
  } catch (error) { report.status = "blocked"; report.error = redact(error.message, secrets); }
  finally {
    report.completedRuns = report.results.length;
    safeSave(join(evidence, "report.json"), report);
    rmSync(work, { recursive: true, force: true });
    console.log(JSON.stringify({ status: report.status, startedRuns: report.startedRuns, completedRuns: report.completedRuns, error: report.error, evidence }, null, 2));
    if (report.status !== "pass") process.exitCode = 1;
  }
}

main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
