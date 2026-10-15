import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, bind, spend, extend, parseDuration, snapshot, handled, ciResult, reclaim, processStart, MARKER } from "../skills/babysit-pr/scripts/babysit-state.mjs";

const NOW = Date.parse("2026-10-14T12:00:00Z");

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "babysit-state-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const checkRun = (name, conclusion, databaseId, runId = databaseId * 10, workflow = 1) => ({
  __typename: "CheckRun", databaseId, name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion,
  detailsUrl: `https://github.com/acme/app/actions/runs/${runId}/job/${databaseId}`,
  checkSuite: { app: { databaseId: 15368 }, workflowRun: { databaseId: runId, workflow: { databaseId: workflow } } },
});
const statusContext = (context, state, createdAt) => ({ __typename: "StatusContext", context, state, targetUrl: `https://ci.example/${context}`, createdAt });
const comment = (id, body, login = "reviewer") => ({ id, author: { login }, body, url: `https://github.com/acme/app/pull/4#${id}` });
const thread = (id, ...comments) => ({ id, isResolved: false, isOutdated: false, path: "src/app.js", line: 3, comments: { nodes: comments } });

function pullRequest(over = {}) {
  return {
    number: 4, url: "https://github.com/acme/app/pull/4", state: "OPEN", isDraft: false, headRefName: "feat/x",
    headRefOid: "aaa", baseRefName: "main", baseOid: "bbb", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: null, required: [], rules: [], checks: [checkRun("test", "SUCCESS", 1)], threads: [], comments: [], reviews: [],
    ...over,
  };
}

// A fake gh over one repository. `prs` is the host's pull request list and `live` the
// GraphQL view of the babysat PR; every call is logged.
function host({ prs = [], live = null } = {}) {
  const calls = [];
  const page = (nodes, args) => {
    const cursor = args.find((a) => a.startsWith("cursor="))?.slice(7);
    const start = cursor ? Number(cursor) : 0;
    const end = Math.min(start + 100, nodes.length);
    return { pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) }, nodes: nodes.slice(start, end) };
  };
  const gh = (args) => {
    calls.push(args);
    const [group, verb] = args;
    if (group === "pr" && verb === "list") {
      const head = args[args.indexOf("--head") + 1];
      return JSON.stringify(prs.filter((p) => p.headRefName === head && p.state === "OPEN"));
    }
    if (group === "pr" && verb === "view") {
      const pr = prs.find((p) => p.number === Number(args[2]));
      if (!pr) throw new Error(`no pull request ${args[2]}`);
      return JSON.stringify(pr);
    }
    if (group === "api" && verb === "graphql") {
      const query = args.find((a) => a.startsWith("query=")).slice(6);
      const p = live;
      if (query.includes("node(id:")) {
        const id = args.find((a) => a.startsWith("id=")).slice(3);
        return JSON.stringify({ data: { node: { comments: page(p.threads.find((x) => x.id === id).comments.nodes, args) } } });
      }
      let pullRequest;
      if (query.includes("reviewThreads(")) {
        const threads = page(p.threads, args);
        pullRequest = { reviewThreads: { ...threads, nodes: threads.nodes.map((x) => ({ ...x, comments: page(x.comments.nodes, []) })) } };
      }
      else if (query.includes("comments(first")) pullRequest = { comments: page(p.comments, args) };
      else if (query.includes("reviews(first")) pullRequest = { reviews: page(p.reviews, args) };
      else pullRequest = {
        number: p.number, url: p.url, state: p.state, isDraft: p.isDraft, headRefName: p.headRefName, headRefOid: p.headRefOid,
        baseRefName: p.baseRefName, mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus, reviewDecision: p.reviewDecision,
        baseRef: { target: { oid: p.baseOid }, refUpdateRule: p.required.length ? { requiredStatusCheckContexts: p.required } : null },
        commits: { nodes: [{ commit: { oid: p.headRefOid, statusCheckRollup: { contexts: page(p.checks, []) } } }] },
      };
      return JSON.stringify({ data: { viewer: { login: "me" }, repository: { pullRequest } } });
    }
    if (group === "api" && verb === `repos/acme/app/rules/branches/${encodeURIComponent(live.baseRefName)}`) {
      if (live.rules instanceof Error) throw live.rules;
      return JSON.stringify(live.rules);
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls, prs };
}

const base = (dir, gh, extra = {}) => ({ dir, gh, repo: "acme/app", branch: "feat/x", now: NOW, ...extra });

// Opens state on PR 4 over a live view, so each test drives only snapshots.
function babysat(t, over = {}) {
  const live = pullRequest(over);
  const h = host({ prs: [{ number: 4, url: live.url, state: "OPEN", headRefName: "feat/x" }], live });
  const { stateFile } = open(base(stateDir(t), h.gh));
  const look = (now = NOW) => snapshot({ file: stateFile, gh: h.gh, now });
  return { live, h, stateFile, look };
}

test("a branch with no open PR asks for one, and a resume after bind reuses it", async (t) => {
  const dir = stateDir(t);
  const h = host();
  const first = await open(base(dir, h.gh));
  assert.equal(first.action, "create");
  assert.equal(first.pr, null);

  h.prs.push({ number: 7, url: "https://github.com/acme/app/pull/7", state: "OPEN", headRefName: "feat/x" });
  bind(first.stateFile, 7);
  const resumed = await open(base(dir, h.gh));
  assert.equal(resumed.action, "reuse");
  assert.equal(resumed.pr, 7);
});

test("several resumes reuse the existing PR, and a closed bound PR is never replaced", async (t) => {
  const dir = stateDir(t);
  const h = host({ prs: [{ number: 12, url: "https://github.com/acme/app/pull/12", state: "OPEN", headRefName: "feat/x" }] });
  for (let run = 0; run < 3; run++) {
    const resumed = open(base(dir, h.gh));
    assert.deepEqual([resumed.action, resumed.pr], ["reuse", 12]);
  }

  h.prs[0].state = "CLOSED";
  const afterClose = open(base(dir, h.gh));
  assert.deepEqual([afterClose.action, afterClose.pr], ["closed", 12]);
});

test("a PR named by number is bound to its own head branch", async (t) => {
  const dir = stateDir(t);
  const h = host({ prs: [{ number: 30, url: "https://github.com/acme/app/pull/30", state: "OPEN", headRefName: "fix/y" }] });
  const named = open(base(dir, h.gh, { branch: undefined, pr: 30 }));
  assert.equal(named.action, "reuse");
  const resumed = open(base(dir, h.gh, { branch: "fix/y" }));
  assert.deepEqual([resumed.action, resumed.pr, resumed.stateFile], ["reuse", 30, named.stateFile]);
});

test("branches whose names differ only in punctuation keep separate state", async (t) => {
  const dir = stateDir(t);
  const h = host({ prs: [{ number: 3, url: "https://github.com/acme/app/pull/3", state: "OPEN", headRefName: "feat/x" }] });
  const slash = open(base(dir, h.gh, { duration: "1h" }));
  spend(slash.stateFile, "repair");
  const dash = open(base(dir, h.gh, { branch: "feat-x", duration: "8h" }));
  assert.notEqual(dash.stateFile, slash.stateFile);
  assert.deepEqual([dash.action, dash.pr, dash.resumed, dash.budgets.repair_cycles_left], ["create", null, false, 2]);
});

test("a resume keeps the monitoring deadline and the recovery budget", async (t) => {
  const dir = stateDir(t);
  const h = host({ prs: [{ number: 4, url: "https://github.com/acme/app/pull/4", state: "OPEN", headRefName: "feat/x" }] });
  const first = open(base(dir, h.gh, { duration: "2h" }));
  assert.equal(first.budgets.deadline_at, "2026-10-14T14:00:00.000Z");
  spend(first.stateFile, "repair");
  spend(first.stateFile, "rerun");

  const resumed = open(base(dir, h.gh, { duration: "8h", now: NOW + 3600_000 }));
  assert.equal(resumed.budgets.deadline_at, "2026-10-14T14:00:00.000Z");
  assert.equal(resumed.budgets.monitor_remaining_seconds, 3600);
  assert.deepEqual([resumed.budgets.repair_cycles_left, resumed.budgets.transient_reruns_left], [1, 0]);

  assert.throws(() => spend(resumed.stateFile, "rerun"), /exhausted/);
  spend(resumed.stateFile, "repair");
  assert.throws(() => spend(resumed.stateFile, "repair"), /exhausted/);
  assert.deepEqual(open(base(dir, h.gh, { now: NOW + 7200_000 })).budgets,
    { deadline_at: "2026-10-14T14:00:00.000Z", monitor_remaining_seconds: 0, repair_cycles_left: 0, transient_reruns_left: 0 });
});

test("a monitoring duration outside one second to seven days is refused by name", () => {
  assert.equal(parseDuration("1h30m"), 5400);
  for (const bad of ["0", "0m", "8d", "200h", "1000000000h", "soon"]) assert.throws(() => parseDuration(bad), new RegExp(bad));
});

test("feedback that arrives while CI is red is handled before CI", async (t) => {
  const { live, stateFile, look } = babysat(t, { checks: [checkRun("test", "FAILURE", 1)], mergeStateStatus: "UNSTABLE" });
  assert.deepEqual(look().next, ["ci"]);

  live.comments.push(comment("C1", "Please rename `x` to `count`."));
  const withFeedback = look();
  assert.deepEqual(withFeedback.next, ["feedback", "ci"]);
  assert.deepEqual(withFeedback.feedback.map((f) => [f.id, f.kind, f.body]), [["C1", "comment", "Please rename `x` to `count`."]]);

  handled(stateFile, { id: "C1", fingerprint: withFeedback.feedback[0].fingerprint, disposition: "fixed" });
  assert.deepEqual(look().next, ["ci"]);
});

test("a check counts per producer: a passing status cannot hide a failing check run of the same name", async (t) => {
  const { look } = babysat(t, { checks: [checkRun("test", "FAILURE", 1), statusContext("test", "SUCCESS", "2026-10-14T12:00:00Z")] });
  const seen = look(NOW);
  assert.deepEqual(seen.checks.failing.map((c) => c.name), ["test"]);
  assert.notEqual(look(NOW + 400_000).outcome, "ready");
});

test("two workflows with a job of the same name are two checks; a rerun replaces only its own", async (t) => {
  for (const order of [[0, 1, 2], [2, 1, 0]]) {
    const runs = [checkRun("test", "FAILURE", 1, 10, 1), checkRun("test", "SUCCESS", 2, 20, 1), checkRun("test", "FAILURE", 3, 30, 2)];
    const { look } = babysat(t, { checks: order.map((i) => runs[i]) });
    const seen = look();
    assert.deepEqual([seen.checks.passing, seen.checks.failing.map((c) => c.run_id)], [1, [30]]);
  }
});

test("an external status follows its latest state", async (t) => {
  const { live, look } = babysat(t, { checks: [statusContext("ci/ext", "PENDING", "2026-10-14T12:00:00Z")] });
  assert.deepEqual(look().checks.running, ["ci/ext"]);
  live.checks.push(statusContext("ci/ext", "FAILURE", "2026-10-14T12:01:00Z"));
  assert.deepEqual(look().checks.failing.map((c) => c.name), ["ci/ext"]);
  live.checks.push(statusContext("ci/ext", "SUCCESS", "2026-10-14T12:02:00Z"));
  assert.deepEqual([look().checks.failing, look().checks.passing], [[], 1]);
});

test("reads every comment of a long review thread, so a late reply reopens it", async (t) => {
  const many = Array.from({ length: 120 }, (_, i) => comment(`TC${i}`, `Point ${i}.`));
  const { live, stateFile, look } = babysat(t, { threads: [thread("T1", ...many)] });
  const [first] = look().feedback;
  assert.equal(first.comments.length, 120);
  handled(stateFile, { id: "T1", fingerprint: first.fingerprint, disposition: "fixed" });
  live.threads[0].comments.nodes.push(comment("TC120", "One more thing at the very end."));
  assert.deepEqual(look().feedback.map((f) => f.id), ["T1"]);
});

test("a reply in a thread the babysitter resolved comes back; a thread resolved before it looked does not", async (t) => {
  const othersResolved = { ...thread("T0", comment("TC0", "Old nit.")), isResolved: true };
  const { live, stateFile, look } = babysat(t, { threads: [othersResolved, thread("T1", comment("TC1", "Rename this."))] });
  const [item] = look().feedback;
  handled(stateFile, { id: item.id, fingerprint: item.fingerprint, disposition: "fixed" });
  live.threads[1].isResolved = true;
  assert.deepEqual(look().feedback, []);

  live.threads[1].comments.nodes.push(comment("TC2", "The rename broke the export."));
  live.threads[0].comments.nodes.push(comment("TC9", "Unrelated follow-up."));
  assert.deepEqual(look().feedback.map((f) => [f.id, f.resolved]), [["T1", true]]);
});

test("a needs-human thread blocks until someone resolves it", async (t) => {
  const { live, stateFile, look } = babysat(t, { threads: [thread("T1", comment("TC1", "Should this ship behind a flag?"))] });
  const [item] = look(NOW).feedback;
  handled(stateFile, { id: item.id, fingerprint: item.fingerprint, disposition: "needs-human" });
  assert.equal(look(NOW).outcome, "blocked");
  live.threads[0].isResolved = true;
  const after = look(NOW + 60_000);
  assert.deepEqual([after.outcome, after.blockers], [null, ["settling before ready"]]);
});

test("a needs-human follow-up raised in a thread that was already resolved stays a blocker", async (t) => {
  const { live, stateFile, look } = babysat(t, { threads: [thread("T1", comment("TC1", "Rename this."))] });
  const [first] = look(NOW).feedback;
  handled(stateFile, { id: first.id, fingerprint: first.fingerprint, disposition: "fixed" });
  live.threads[0].isResolved = true;
  live.threads[0].comments.nodes.push(comment("TC2", "Should the old name stay as an alias for v1 users?"));
  const [followUp] = look(NOW).feedback;
  assert.equal(followUp.resolved, true);
  handled(stateFile, { id: followUp.id, fingerprint: followUp.fingerprint, disposition: "needs-human" });
  const later = look(NOW + 600_000);
  assert.deepEqual([later.outcome, later.blockers], ["blocked", ["needs-human: https://github.com/acme/app/pull/4#TC1"]]);
});

test("a reopen seen after the babysitter's snapshot is kept when it records the park", async (t) => {
  const { live, stateFile, look } = babysat(t, { threads: [thread("T1", comment("TC1", "Rename this."))] });
  const [first] = look(NOW).feedback;
  handled(stateFile, { id: first.id, fingerprint: first.fingerprint, disposition: "fixed" });
  live.threads[0].isResolved = true;
  live.threads[0].comments.nodes.push(comment("TC2", "Should the old name stay as an alias?"));
  const [seenResolved] = look(NOW).feedback;
  live.threads[0].isResolved = false;
  look(NOW);
  handled(stateFile, { id: seenResolved.id, fingerprint: seenResolved.fingerprint, disposition: "needs-human" });
  live.threads[0].isResolved = true;
  const after = look(NOW + 60_000);
  assert.deepEqual([after.outcome, after.blockers], [null, ["settling before ready"]]);
});

test("a park in a thread reopened before the babysitter looked counts only later reopens", async (t) => {
  const { live, stateFile, look } = babysat(t, { threads: [thread("T1", comment("TC1", "Rename this."))] });
  const [first] = look(NOW).feedback;
  handled(stateFile, { id: first.id, fingerprint: first.fingerprint, disposition: "fixed" });
  live.threads[0].isResolved = true;
  look(NOW);
  live.threads[0].isResolved = false;
  look(NOW);
  live.threads[0].isResolved = true;
  live.threads[0].comments.nodes.push(comment("TC2", "Should the old name stay as an alias?"));
  const [followUp] = look(NOW).feedback;
  handled(stateFile, { id: followUp.id, fingerprint: followUp.fingerprint, disposition: "needs-human" });
  assert.equal(look(NOW + 600_000).outcome, "blocked");
});

test("a park records the resolution the babysitter saw, not one a later snapshot saw", async (t) => {
  const { live, stateFile, look } = babysat(t, { threads: [thread("T1", comment("TC1", "Should this ship behind a flag?"))] });
  const [seenOpen] = look(NOW).feedback;
  live.threads[0].isResolved = true;
  look(NOW);
  handled(stateFile, { id: seenOpen.id, fingerprint: seenOpen.fingerprint, disposition: "needs-human" });
  const after = look(NOW + 60_000);
  assert.deepEqual([after.outcome, after.blockers], [null, ["settling before ready"]]);
});

test("a park raised in a resolved thread is released when someone reopens and then resolves it", async (t) => {
  const { live, stateFile, look } = babysat(t, { threads: [thread("T1", comment("TC1", "Rename this."))] });
  const [first] = look(NOW).feedback;
  handled(stateFile, { id: first.id, fingerprint: first.fingerprint, disposition: "fixed" });
  live.threads[0].isResolved = true;
  live.threads[0].comments.nodes.push(comment("TC2", "Should the old name stay as an alias for v1 users?"));
  const [followUp] = look(NOW).feedback;
  handled(stateFile, { id: followUp.id, fingerprint: followUp.fingerprint, disposition: "needs-human" });
  live.threads[0].isResolved = false;
  assert.equal(look(NOW).outcome, "blocked");
  live.threads[0].isResolved = true;
  const released = look(NOW + 60_000);
  assert.deepEqual([released.outcome, released.blockers], [null, ["settling before ready"]]);
});

// A held lock makes a contender wait; tests keep that wait short.
process.env.SUPERMATT_LOCK_WAIT_MS = "300";

function liveProcess(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  return child;
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid;
}

test("a write waits while another live session holds the lock, then proceeds once that session is gone", async (t) => {
  const { stateFile } = babysat(t);
  const owner = liveProcess(t);
  writeFileSync(`${stateFile}.lock`, String(owner.pid));
  const old = new Date(Date.now() - 7200_000);
  utimesSync(`${stateFile}.lock`, old, old);
  assert.throws(() => spend(stateFile, "repair"), /locked by another session/);

  owner.kill();
  await once(owner, "exit");
  assert.equal(spend(stateFile, "repair").repair_cycles_left, 1);
});

test("a lock left by a crashed session is reclaimed", async (t) => {
  const { stateFile } = babysat(t);
  writeFileSync(`${stateFile}.lock`, String(await deadPid()));
  assert.equal(spend(stateFile, "repair").repair_cycles_left, 1);
});

test("an empty lock file, left by a crash before it named its owner, is reclaimed", async (t) => {
  const { stateFile } = babysat(t);
  writeFileSync(`${stateFile}.lock`, "");
  assert.equal(spend(stateFile, "repair").repair_cycles_left, 1);
});

test("a reclaim guard is removed only by its owner: a dead one stops the run with the path to delete", async (t) => {
  const { stateFile } = babysat(t);
  writeFileSync(`${stateFile}.lock`, String(await deadPid()));
  const reclaimer = liveProcess(t);
  writeFileSync(`${stateFile}.lock.reclaim`, String(reclaimer.pid));
  assert.throws(() => spend(stateFile, "repair"), /locked by another session/);

  reclaimer.kill();
  await once(reclaimer, "exit");
  assert.throws(() => spend(stateFile, "repair"), new RegExp(`left by a crashed session: delete ${stateFile}\\.lock\\.reclaim`));
  assert.equal(readFileSync(`${stateFile}.lock.reclaim`, "utf8"), String(reclaimer.pid));

  rmSync(`${stateFile}.lock.reclaim`);
  assert.equal(spend(stateFile, "repair").repair_cycles_left, 1);
});

test("a reclaimer that finds a live owner in place, after seeing a dead one, leaves the lock alone", async (t) => {
  const { stateFile } = babysat(t);
  const owner = liveProcess(t);
  writeFileSync(`${stateFile}.lock`, String(owner.pid));
  assert.equal(reclaim(`${stateFile}.lock`), false);
  assert.equal(readFileSync(`${stateFile}.lock`, "utf8"), String(owner.pid));
});

test("a GitHub read that hangs is cut off, and the lock is released", async (t) => {
  const { stateFile } = babysat(t);
  const bin = mkdtempSync(join(tmpdir(), "babysit-stub-gh-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const marker = join(bin, "called");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n: > "${marker}"\nexec sleep 30\n`, { mode: 0o755 });
  const cli = fileURLToPath(new URL("../skills/babysit-pr/scripts/babysit-state.mjs", import.meta.url));
  const started = Date.now();
  const child = spawn(process.execPath, [cli, "snapshot", "--state", stateFile], {
    env: { PATH: `${bin}:/usr/bin:/bin`, SUPERMATT_GH_TIMEOUT_MS: "2000" }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const killer = setTimeout(() => child.kill(), 10_000);
  const [code] = await once(child, "exit");
  clearTimeout(killer);
  assert.ok(existsSync(marker), `the stub gh was reached: ${stderr}`);
  assert.notEqual(code, 0);
  assert.ok(Date.now() - started < 8_000, `cut off in time: ${stderr}`);
  assert.equal(existsSync(`${stateFile}.lock`), false);
});

// Runs `spend` in a separate CLI process with the given environment; returns its exit and stderr.
async function spendInChild(stateFile, env) {
  const cli = fileURLToPath(new URL("../skills/babysit-pr/scripts/babysit-state.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, "spend", "--state", stateFile, "repair"], { env: { SUPERMATT_LOCK_WAIT_MS: "300", ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const [code] = await once(child, "exit");
  return { code, stderr };
}

test("a contender that reads start times differently, or cannot read them, keeps a live owner's lock", async (t) => {
  const { stateFile } = babysat(t);
  const owner = liveProcess(t);
  writeFileSync(`${stateFile}.lock`, `${owner.pid} ${processStart(owner.pid)}`);
  for (const env of [{ PATH: "/usr/bin:/bin", TZ: "Pacific/Kiritimati", LC_ALL: "fr_FR.UTF-8" }, { PATH: "/nonexistent" }]) {
    const { code, stderr } = await spendInChild(stateFile, env);
    assert.deepEqual([code, /locked by another session/.test(stderr)], [1, true], `${JSON.stringify(env)}: ${stderr}`);
  }
});

test("a lock names its owner by pid and start time: the same pid with another start time is a reused pid", async (t) => {
  const { stateFile } = babysat(t);
  const owner = liveProcess(t);
  writeFileSync(`${stateFile}.lock`, `v1 ${owner.pid} ${processStart(owner.pid)}`);
  assert.throws(() => spend(stateFile, "repair"), /locked by another session/);
  writeFileSync(`${stateFile}.lock`, `v1 ${owner.pid} Thu Jan 1 00:00:00 1970`);
  assert.equal(spend(stateFile, "repair").repair_cycles_left, 1);
});

test("a lock in an older format naming a live pid is kept, whatever start time it carries", async (t) => {
  const { stateFile } = babysat(t);
  const owner = liveProcess(t);
  writeFileSync(`${stateFile}.lock`, `${owner.pid} Fri Oct 16 01:00:00 2026`);
  assert.throws(() => spend(stateFile, "repair"), /locked by another session/);
  writeFileSync(`${stateFile}.lock`, `${await deadPid()} Fri Oct 16 01:00:00 2026`);
  assert.equal(spend(stateFile, "repair").repair_cycles_left, 1);
});

test("a snapshot holds the lock across its GitHub reads, so no write lands inside it", async (t) => {
  const { h, stateFile } = babysat(t);
  let inside = null;
  let record = null;
  const gh = (args) => {
    if (inside === null && args[1] === "graphql") {
      record = readFileSync(`${stateFile}.lock`, "utf8");
      try { spend(stateFile, "repair"); inside = "ran"; } catch (error) { inside = error.message; }
    }
    return h.gh(args);
  };
  snapshot({ file: stateFile, gh, now: NOW });
  assert.match(inside, /locked by another session/);
  assert.equal(record, `v1 ${process.pid} ${processStart(process.pid)}`);
  assert.equal(spend(stateFile, "repair").repair_cycles_left, 1);
});

test("the branch is updated only when GitHub reports it behind or conflicting, after feedback", async (t) => {
  for (const [mergeStateStatus, expected] of [["BEHIND", ["update-branch"]], ["DIRTY", ["update-branch"]], ["CLEAN", ["wait"]]]) {
    const { live, look } = babysat(t, { mergeStateStatus, baseOid: "moved-base" });
    assert.deepEqual(look().next, expected, mergeStateStatus);
    live.comments.push(comment("C1", "One more thing."));
    assert.equal(look().next[0], "feedback", mergeStateStatus);
  }
});

test("human-owned blockers end the run blocked once nothing else is running, and name themselves", async (t) => {
  for (const [over, reason] of [
    [{ isDraft: true }, "draft"],
    [{ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" }, "review required"],
    [{ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "CLEAN" }, "changes requested"],
  ]) {
    const { live, look } = babysat(t, { ...over, checks: [checkRun("test", null, 1)] });
    assert.equal(look().outcome, null, reason);
    live.checks = [checkRun("test", "SUCCESS", 1)];
    const done = look();
    assert.deepEqual([done.outcome, done.blockers], ["blocked", [reason]], reason);
  }
});

test("recover-ci outcomes: a rerun waits for its result, an exhausted budget ends the run", async (t) => {
  const rerun = babysat(t, { checks: [checkRun("test", "FAILURE", 1)], mergeStateStatus: "UNSTABLE" });
  ciResult(rerun.stateFile, { key: rerun.look().checks.failing[0].key, outcome: "rerun" });
  const waiting = rerun.look();
  assert.deepEqual([waiting.outcome, waiting.next, waiting.blockers], [null, ["wait"], ["rerun requested: test"]]);

  const spent = babysat(t, { checks: [checkRun("test", "FAILURE", 1)], mergeStateStatus: "UNSTABLE" });
  ciResult(spent.stateFile, { key: spent.look().checks.failing[0].key, outcome: "budget-exhausted" });
  assert.equal(spent.look().outcome, "budget-exhausted");
});

test("an edited comment or a new reply is pending again; the babysitter's own replies are not", async (t) => {
  const { live, stateFile, look } = babysat(t, {
    comments: [comment("C1", "Typo in the README.")],
    threads: [thread("T1", comment("TC1", "This loop is off by one."))],
  });
  const handleAll = () => { for (const f of look().feedback) handled(stateFile, { id: f.id, fingerprint: f.fingerprint, disposition: "fixed" }); };
  handleAll();

  live.threads[0].comments.nodes.push(comment("TC2", `Fixed in abc123. ${MARKER}`, "me"));
  live.comments.push(comment("C2", `Done. ${MARKER}`, "me"));
  assert.deepEqual(look().feedback, []);

  live.comments[0].body = "Typo in the README, and in CONTRIBUTING.";
  live.threads[0].comments.nodes.push(comment("TC3", "Still off by one at the end."));
  assert.deepEqual(look().feedback.map((f) => f.id).sort(), ["C1", "T1"]);
});

test("the reply marker hides only the babysitter's own comments, not a reviewer's", async (t) => {
  const { look } = babysat(t, {
    comments: [comment("C1", `Please add an empty-input test. ${MARKER}`)],
    threads: [thread("T1", comment("TC1", `Rename this. ${MARKER}`))],
    reviews: [{ ...comment("R1", `Needs a changelog entry. ${MARKER}`), state: "COMMENTED" }],
  });
  assert.deepEqual(look().feedback.map((f) => f.id).sort(), ["C1", "R1", "T1"]);
});

test("a resolved thread and an empty review body are not feedback", async (t) => {
  const resolved = { ...thread("T1", comment("TC1", "Nit.")), isResolved: true };
  const { look } = babysat(t, { threads: [resolved], reviews: [{ ...comment("R1", ""), state: "APPROVED" }] });
  assert.deepEqual(look().feedback, []);
});

test("reads review threads past the first page", async (t) => {
  const threads = Array.from({ length: 150 }, (_, i) => thread(`T${i}`, comment(`TC${i}`, `Point ${i}.`)));
  const { look } = babysat(t, { threads });
  assert.equal(look().feedback.length, 150);
});

test("head movement invalidates CI results and the ready candidate", async (t) => {
  const { live, stateFile, look } = babysat(t, { checks: [checkRun("test", "FAILURE", 1)], mergeStateStatus: "UNSTABLE" });
  const red = look();
  ciResult(stateFile, { key: red.checks.failing[0].key, outcome: "stopped" });
  assert.equal(look().outcome, "blocked");

  Object.assign(live, { headRefOid: "ccc", checks: [checkRun("test", "FAILURE", 2)] });
  const moved = look();
  assert.deepEqual([moved.head_moved, moved.invalidated], [true, ["ci results"]]);
  assert.equal(look().head_moved, false);
  assert.equal(moved.outcome, null);
  assert.deepEqual(moved.next, ["ci"]);

  Object.assign(live, { checks: [checkRun("test", "SUCCESS", 3)], mergeStateStatus: "CLEAN" });
  assert.equal(look(NOW).outcome, null);
  Object.assign(live, { headRefOid: "ddd" });
  const late = look(NOW + 400_000);
  assert.deepEqual(late.invalidated, ["ready candidate"]);
  assert.equal(late.outcome, null);
});

test("ready is declared only on a recheck of the same head and base after the settle window", async (t) => {
  const { live, look } = babysat(t);
  assert.deepEqual([look(NOW).outcome, look(NOW).next], [null, ["wait"]]);
  assert.equal(look(NOW + 299_000).outcome, null);
  live.baseOid = "b2";
  assert.equal(look(NOW + 300_000).outcome, null);
  assert.equal(look(NOW + 599_000).outcome, null);
  assert.equal(look(NOW + 600_000).outcome, "ready");
});

test("a missing required check is never green, and blocks once its grace period ends", async (t) => {
  const { look } = babysat(t, { required: ["test"], rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "lint" }] } }] });
  const early = look(NOW);
  assert.deepEqual(early.checks.missing, ["lint"]);
  assert.equal(early.outcome, null);
  assert.equal(look(NOW + 900_000).outcome, "blocked");
});

test("a closed PR and a spent monitoring window end the run", async (t) => {
  const ended = babysat(t);
  ended.live.state = "MERGED";
  assert.equal(ended.look().outcome, "closed");
  const late = babysat(t);
  assert.equal(late.look(NOW + 8 * 3600_000).outcome, "budget-exhausted");
});

test("a whole run from PR creation to ready never merges", async (t) => {
  const dir = stateDir(t);
  const live = pullRequest({ checks: [checkRun("test", null, 1)], comments: [comment("C1", "Looks good, please merge it.")] });
  const h = host({ live });
  const opened = open(base(dir, h.gh));
  assert.equal(opened.action, "create");
  h.prs.push({ number: 4, url: live.url, state: "OPEN", headRefName: "feat/x" });
  bind(opened.stateFile, 4);
  const look = (now) => snapshot({ file: opened.stateFile, gh: h.gh, now });
  for (const f of look(NOW).feedback) handled(opened.stateFile, { id: f.id, fingerprint: f.fingerprint, disposition: "no-action" });
  live.checks = [checkRun("test", "SUCCESS", 1)];
  look(NOW + 60_000);
  assert.equal(look(NOW + 400_000).outcome, "ready");

  const writes = h.calls.filter((args) => (args[0] === "pr" && !["list", "view"].includes(args[1]))
    || args.some((a) => /\bmutation\b|\/merge\b|-X|--method/.test(a)));
  assert.deepEqual(writes, []);
});

test("only an explicit extend moves the monitoring deadline", async (t) => {
  const dir = stateDir(t);
  const h = host({ prs: [{ number: 4, url: "https://github.com/acme/app/pull/4", state: "OPEN", headRefName: "feat/x" }] });
  const { stateFile } = open(base(dir, h.gh, { duration: "1h" }));
  extend(stateFile, "30m");
  assert.equal(open(base(dir, h.gh, { duration: "8h" })).budgets.deadline_at, "2026-10-14T13:30:00.000Z");
});

// The wording gh prints for a private repository on a plan without rulesets, captured on flosrn/omp.
const planError = () => new Error("Command failed: gh api repos/acme/app/rules/branches/main\ngh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\n");

test("a private repository whose plan has no rulesets has no ruleset checks; other rule errors still fail", (t) => {
  const { look } = babysat(t, { rules: planError(), required: ["build"], checks: [checkRun("build", "SUCCESS", 1)] });
  const report = look();
  assert.deepEqual(report.checks.required, ["build"]);
  assert.deepEqual(report.checks.missing, []);

  const denied = babysat(t, { rules: new Error("Command failed: gh api repos/acme/app/rules/branches/main\ngh: Not Found (HTTP 404)\n") });
  assert.throws(() => denied.look(), /HTTP 404/);
});
