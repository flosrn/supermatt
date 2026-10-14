import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, bind, spend, extend, parseDuration, snapshot, handled, ciResult, MARKER } from "../skills/babysit-pr/scripts/babysit-state.mjs";

const NOW = Date.parse("2026-10-14T12:00:00Z");

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "babysit-state-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const checkRun = (name, conclusion, databaseId, runId = databaseId * 10) => ({
  __typename: "CheckRun", databaseId, name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion,
  detailsUrl: `https://github.com/acme/app/actions/runs/${runId}/job/${databaseId}`, checkSuite: { workflowRun: { databaseId: runId } },
});
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
      let pullRequest;
      if (query.includes("reviewThreads(")) pullRequest = { reviewThreads: page(p.threads, args) };
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
    if (group === "api" && verb === `repos/acme/app/rules/branches/${encodeURIComponent(live.baseRefName)}`) return JSON.stringify(live.rules);
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
