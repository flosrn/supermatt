#!/usr/bin/env node
// Durable state for babysit-pr: which PR this branch babysits, the monitoring deadline,
// the CI recovery counters, handled feedback, and evidence tied to the current head.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// A gh call that hangs (network, credential prompt) would hold the state lock: cut it off.
const ghTimeoutMs = () => Number(process.env.SUPERMATT_GH_TIMEOUT_MS ?? 120_000);
// An explicit `stdio` keeps gh's stderr in the thrown error only: by default execFileSync also
// echoes it, and an expected refusal (rulesets on a free private repository) read as a failure.
const realGh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: ghTimeoutMs(), killSignal: "SIGKILL" });

// A readable slug for people, plus a hash of the exact key: two branches whose names slug
// alike ("feat/x", "feat-x") must never share state. A bound PR's record is keyed by the PR,
// since two PRs can share a head branch name; the branch's file serves discovery before a
// PR exists, and afterwards names the PR the branch was bound to last. A branch name holds
// no NUL, so the two hash inputs never meet.
const named = (dir, label, exact) =>
  join(dir, `${label.replace(/[^A-Za-z0-9._-]+/g, "-")}-${createHash("sha256").update(exact).digest("hex").slice(0, 12)}.json`);
const branchFile = (dir, repo, branch) => named(dir, `${repo}#${branch}`, `${repo}\0${branch}`);
const prFile = (dir, repo, pr) => named(dir, `${repo}#pr-${pr}`, `${repo}\0pr\0${pr}`);

function load(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function save(file, state) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n");
  renameSync(temp, file);
}

// Two sessions on one PR must not lose each other's writes: every read-modify-write,
// GitHub reads included, holds a lock file naming its process. A contender waits while
// that process lives and reclaims the lock only from a process that is gone.
const lockWaitMs = () => Number(process.env.SUPERMATT_LOCK_WAIT_MS ?? 120_000);

// When a process started, as ps prints it: with the pid, it names one process across pid
// reuse. Read in UTC and the C locale, so every session renders the same process alike.
// Empty where ps cannot tell (no such process, or no ps).
export function processStart(pid) {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).trim().replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The lock record format: "v1 <pid> <start>", start as processStart renders it. A record in
// another format still names its pid, but its start time is not comparable with ours.
const LOCK_FORMAT = "v1";

// Who a lock file names, as { pid, start }: undefined when there is no file, null when it
// names no one. `start` is empty when it is unknown or not comparable.
function ownerOf(path) {
  let text;
  try { text = readFileSync(path, "utf8").trim(); } catch { return undefined; }
  const words = text.split(" ");
  const versioned = words[0] === LOCK_FORMAT;
  const pid = Number(versioned ? words[1] : words[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, start: versioned ? words.slice(2).join(" ") : "" };
}

let ownStart;
const me = () => `${LOCK_FORMAT} ${process.pid} ${(ownStart ??= processStart(process.pid))}`;

// A lock file is written complete, then linked into place: it is never seen half written,
// so one that names no live process is debris. A live pid with another start time is a
// reused pid, not the owner.
const abandoned = (path) => {
  const owner = ownerOf(path);
  if (owner === undefined) return false;
  if (owner === null || !alive(owner.pid)) return true;
  // A start time this session cannot read proves nothing: only a readable, different one
  // marks a reused pid.
  const start = owner.start === "" ? "" : processStart(owner.pid);
  return start !== "" && start !== owner.start;
};

function claim(path) {
  const draft = `${path}.${process.pid}.draft`;
  writeFileSync(draft, me());
  try {
    linkSync(draft, path);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(draft, { force: true });
  }
}

// One reclaimer at a time, rechecking under its guard, so a lock a live session took
// meanwhile is never removed. Only its owner removes a guard: any other removal could hit a
// live guard published after the check. A guard exists for microseconds, so a dead one means
// a crash inside that window, and a person deletes it.
export function reclaim(lock) {
  const guard = `${lock}.reclaim`;
  if (!claim(guard)) {
    if (abandoned(guard)) throw new Error(`reclaim guard left by a crashed session: delete ${guard} once no babysit-pr run is active`);
    return false;
  }
  try {
    if (!abandoned(lock)) return false;
    rmSync(lock, { force: true });
    return true;
  } finally {
    rmSync(guard, { force: true });
  }
}

function locked(file, work) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + lockWaitMs();
  while (!claim(lock)) {
    if (abandoned(lock) && reclaim(lock)) continue;
    if (Date.now() > deadline) throw new Error(`state is locked by another session (pid ${ownerOf(lock)?.pid}): ${lock}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try {
    return work();
  } finally {
    if (ownerOf(lock)?.pid === process.pid) rmSync(lock, { force: true });
  }
}

// A branch file that names its bound PR forwards every write to that PR's record, so a FILE
// kept from before the bind still writes where the PR's state lives.
function update(file, change) {
  return locked(file, () => {
    const state = load(file);
    if (state.bound_pr != null) return update(prFile(dirname(file), state.repo, state.bound_pr), change);
    const result = change(state);
    save(file, state);
    return result;
  });
}

const LIMITS = { repair: 2, rerun: 1 };
const DEFAULT_DURATION = "8h";

const MAX_DURATION_SECONDS = 7 * 24 * 3600;

// "8h", "90m", "1h30m", "45s", or a bare number of seconds; one second to seven days.
export function parseDuration(text) {
  const value = String(text).trim();
  const parts = /^\d+$/.test(value) ? [[value, value, "s"]] : [...value.matchAll(/(\d+)([hms])/g)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== value) throw new Error(`bad duration: ${text} (use 90m, 8h, 1h30m)`);
  const seconds = parts.reduce((sum, [, n, unit]) => sum + Number(n) * { h: 3600, m: 60, s: 1 }[unit], 0);
  if (!(seconds >= 1 && seconds <= MAX_DURATION_SECONDS)) throw new Error(`duration out of range: ${text} (one second to seven days)`);
  return seconds;
}

function budgets(state, now) {
  const deadline = Date.parse(state.monitor.deadline_at);
  return {
    deadline_at: state.monitor.deadline_at,
    monitor_remaining_seconds: Math.max(0, Math.floor((deadline - now) / 1000)),
    repair_cycles_left: LIMITS.repair - state.recovery.repair_cycles_used,
    transient_reruns_left: LIMITS.rerun - state.recovery.transient_reruns_used,
  };
}

function fresh({ repo, branch, now, duration }) {
  return {
    version: 1, repo, branch, pr: null,
    monitor: { started_at: new Date(now).toISOString(), deadline_at: new Date(now + parseDuration(duration) * 1000).toISOString() },
    recovery: { repair_cycles_used: 0, transient_reruns_used: 0, spends: [] },
  };
}

const viewPr = (gh, repo, number) =>
  JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", "number,url,state,headRefName"]));

// The open PR this branch's owner or the viewer pushed, or null when there is none.
function discover(gh, repo, branch) {
  // `--head` matches the branch name only, so a fork's PR with the same name would match.
  // This branch's PR is pushed by the repository's owner or by the viewer, from a fork.
  const owners = new Set([repo.split("/")[0], gh(["api", "user", "--jq", ".login"]).trim()]);
  const openPrs = JSON.parse(gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url,state,headRefName,headRepositoryOwner"]))
    .filter((p) => owners.has(p.headRepositoryOwner?.login));
  if (openPrs.length > 1) throw new Error(`several open PRs for ${branch}: ${openPrs.map((p) => p.number).join(", ")}`);
  return openPrs[0]?.number ?? null;
}

// Binds a branch to a PR: the PR's own record when it has one, else `seed` (the branch's
// record from before the PR existed, or a fresh one). The branch file then names the PR.
// The caller holds the branch file's lock; locks are always taken branch file first.
function attach(discovery, seed, pr) {
  const stateFile = prFile(dirname(discovery), seed.repo, pr);
  return locked(stateFile, () => {
    const existing = existsSync(stateFile) ? load(stateFile) : null;
    const state = existing ?? { ...seed, pr };
    save(stateFile, state);
    save(discovery, { version: 1, repo: seed.repo, branch: seed.branch, bound_pr: pr });
    return { stateFile, state, existing: existing != null };
  });
}

// Finds the PR to babysit, or says one must be created. A PR once bound stays bound:
// when it is closed or merged the outcome is closed, never a second PR for the branch.
// The monitoring deadline and recovery counters are set when a PR's record is created; a
// resume keeps them, whatever duration it passes. Each PR keeps its own record, so naming
// another PR with the same head branch name never touches the first one's.
export function open({ dir, gh = realGh, repo, branch, pr = null, duration = DEFAULT_DURATION, now = Date.now() }) {
  if (pr != null) branch = viewPr(gh, repo, pr).headRefName;
  mkdirSync(dir, { recursive: true });
  const discovery = branchFile(dir, repo, branch);
  return locked(discovery, () => {
    const found = existsSync(discovery) ? load(discovery) : null;
    const unbound = found?.bound_pr == null ? found : null;
    pr ??= found?.bound_pr ?? discover(gh, repo, branch);
    if (pr == null) {
      const state = unbound ?? fresh({ repo, branch, now, duration });
      save(discovery, state);
      return { action: "create", pr: null, stateFile: discovery, resumed: unbound != null, budgets: budgets(state, now) };
    }
    const { stateFile, state, existing } = attach(discovery, unbound ?? fresh({ repo, branch, now, duration }), pr);
    const action = viewPr(gh, repo, pr).state === "OPEN" ? "reuse" : "closed";
    return { action, pr, stateFile, resumed: existing || unbound != null, budgets: budgets(state, now) };
  });
}

export class BudgetExhausted extends Error {}

// Records one CI recovery spend before it is acted on. Refuses past the budget.
export function spend(file, kind, { note = "", now = Date.now() } = {}) {
  if (!(kind in LIMITS)) throw new Error(`unknown spend: ${kind} (repair or rerun)`);
  return update(file, (state) => {
    const field = kind === "repair" ? "repair_cycles_used" : "transient_reruns_used";
    if (state.recovery[field] >= LIMITS[kind]) throw new BudgetExhausted(`${kind} budget exhausted (${LIMITS[kind]} used)`);
    state.recovery[field]++;
    state.recovery.spends.push({ kind, at: new Date(now).toISOString(), head: state.head?.sha ?? null, note });
    return budgets(state, now);
  });
}

// Binds the PR just created to the branch's record and returns the PR's state file.
export function bind(file, pr) {
  if (!Number.isInteger(pr)) throw new Error("bind needs --pr N");
  return locked(file, () => {
    const state = load(file);
    const bound = state.bound_pr ?? state.pr;
    if (bound != null && bound !== pr) throw new Error(`state already bound to PR ${bound}`);
    if (state.bound_pr != null) return prFile(dirname(file), state.repo, pr);
    if (state.pr != null) return file;
    return attach(file, state, pr).stateFile;
  });
}

// Adds time to the monitoring window. Only the user asks for this; a resume never does.
export function extend(file, duration, { now = Date.now() } = {}) {
  return update(file, (state) => {
    state.monitor.deadline_at = new Date(Date.parse(state.monitor.deadline_at) + parseDuration(duration) * 1000).toISOString();
    return budgets(state, now);
  });
}

// The babysitter ends every reply it posts with this marker, so its own replies never
// count as new feedback or change a thread's fingerprint. Anyone can paste the marker,
// so it counts only on comments the authenticated gh account wrote.
export const MARKER = "<!-- supermatt:babysit-pr -->";
const SETTLE_SECONDS = 300;
const MISSING_CHECK_GRACE_SECONDS = 600;
// A thread's handed-out fingerprint carries what the babysitter saw: ".resolved" or ".open",
// and how many reopens had been seen ("<hash>.resolved.2").
const THREAD_SEEN = /^(.*)\.(resolved|open)\.(\d+)$/;

const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const ours = (comment, viewer) => comment.author?.login === viewer && (comment.body ?? "").includes(MARKER);

const CHECKS = `contexts(first: 100) { pageInfo { hasNextPage endCursor } nodes { __typename
  ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { app { databaseId } workflowRun { databaseId workflow { databaseId } } } }
  ... on StatusContext { context state targetUrl createdAt } } }`;
const CORE = `query($owner: String!, $name: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) {
  number url state isDraft headRefName headRefOid baseRefName mergeable mergeStateStatus reviewDecision
  baseRef { target { oid } refUpdateRule { requiredStatusCheckContexts } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { ${CHECKS} } } } } } } }`;
const COMMENT_PAGE = "pageInfo { hasNextPage endCursor } nodes { id author { login } body url }";
const CONNECTIONS = {
  reviewThreads: `reviewThreads(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated path line comments(first: 100) { ${COMMENT_PAGE} } } }`,
  comments: `comments(first: 100, after: $cursor) { ${COMMENT_PAGE} }`,
  reviews: "reviews(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id author { login } body url state } }",
};
const THREAD_COMMENTS = `query($id: ID!, $cursor: String) { node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { ${COMMENT_PAGE} } } } }`;

function graphql(gh, query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value != null) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  }
  const response = JSON.parse(gh(args));
  if (response.errors?.length) throw new Error(`GitHub GraphQL: ${response.errors.map((e) => e.message).join("; ")}`);
  if (!response.data) throw new Error("GitHub GraphQL: empty response");
  return response.data;
}

function pullRequestOf(data) {
  if (!data.repository?.pullRequest) throw new Error("GitHub GraphQL: pull request not found");
  return data.repository.pullRequest;
}

// Follows a connection to its last page: a first page alone undercounts open feedback.
function pages(first, next) {
  const nodes = [...first.nodes];
  for (let page = first; page.pageInfo.hasNextPage;) {
    page = next(page.pageInfo.endCursor);
    nodes.push(...page.nodes);
  }
  return nodes;
}

function all(gh, repo, number, name) {
  const [owner, repoName] = repo.split("/");
  const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${CONNECTIONS[name]} } } }`;
  const read = (cursor) => pullRequestOf(graphql(gh, query, { owner, name: repoName, number, cursor }))[name];
  return pages(read(null), read);
}

// Every comment of one review thread, past its first hundred.
function threadComments(gh, thread) {
  return pages(thread.comments, (cursor) => {
    const comments = graphql(gh, THREAD_COMMENTS, { id: thread.id, cursor }).node?.comments;
    if (!comments) throw new Error(`GitHub GraphQL: review thread ${thread.id} not found`);
    return comments;
  });
}

// A check is identified by its producer, not its display name: a status and a check run,
// or jobs of two workflows, can share a name and must each pass. A status and a non-Actions
// check run keep their newest report; Actions jobs are chosen by `actionsJobs`.
function check(node) {
  if (node.__typename === "CheckRun") {
    const status = node.status !== "COMPLETED" ? "pending" : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(node.conclusion) ? "pass" : "fail";
    const suite = node.checkSuite ?? {};
    const workflow = suite.workflowRun?.workflow?.databaseId;
    const producer = workflow != null ? `workflow:${workflow}` : `app:${suite.app?.databaseId}`;
    return { name: node.name, identity: `check-run:${producer}:${node.name}`, order: node.databaseId, key: `check-run:${node.databaseId}`,
      status, conclusion: node.conclusion, url: node.detailsUrl, run_id: suite.workflowRun?.databaseId ?? null, actions: workflow != null };
  }
  const status = node.state === "SUCCESS" ? "pass" : ["PENDING", "EXPECTED"].includes(node.state) ? "pending" : "fail";
  return { name: node.context, identity: `status:${node.context}`, order: Date.parse(node.createdAt), key: `status:${node.context}:${node.createdAt}`,
    status, conclusion: node.state, url: node.targetUrl, run_id: null, actions: false };
}

// The attempt of every job of one workflow run, by job id (an Actions job id is its check run id).
function attempts(gh, repo, run) {
  const out = gh(["api", `repos/${repo}/actions/runs/${run}/jobs?filter=all&per_page=100`, "--paginate", "--jq", '.jobs[] | "\\(.id) \\(.run_attempt)"']);
  return new Map(out.split("\n").filter(Boolean).map((line) => line.split(" ").map(Number)));
}

// Jobs of one workflow run can share a display name and must each pass, and a rerun reports
// a new attempt of the same run under the same names. Per workflow and name, the newest
// run's newest attempt stands, every job of it. An older attempt's failures are replaced only
// when the newest attempt has at least as many jobs of that name: a rerun of one of several
// same-name failed jobs cannot say which it replaced, so those failures stay.
function actionsJobs(gh, repo, runs) {
  const attempt = new Map();
  for (const run of new Set(runs.map((c) => c.run_id))) for (const [id, n] of attempts(gh, repo, run)) attempt.set(id, n);
  const groups = new Map();
  for (const c of runs) {
    // A job the jobs API does not list has no attempt evidence: it stands alone, never replaced.
    const n = attempt.get(Number(c.key.slice("check-run:".length)));
    const group = n == null ? c.key : c.identity;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ ...c, attempt: n ?? null, execution: [c.run_id, n ?? 0] });
  }
  const kept = [];
  for (const jobs of groups.values()) {
    const newer = (a, b) => a.execution[0] - b.execution[0] || a.execution[1] - b.execution[1];
    const newest = jobs.reduce((a, b) => (newer(b, a) > 0 ? b : a));
    const current = jobs.filter((j) => newer(j, newest) === 0);
    kept.push(...current);
    const older = new Map();
    for (const j of jobs.filter((x) => newer(x, newest) < 0 && x.status === "fail")) {
      const at = j.execution.join(":");
      older.set(at, [...(older.get(at) ?? []), j]);
    }
    for (const failed of older.values()) if (failed.length > current.length) kept.push(...failed);
  }
  return kept;
}

// Rulesets on a private repository need a paid plan; without one GitHub answers 403 with
// this wording, and no ruleset can apply to the branch. Any other failure is a failed read.
const PLAN_WITHOUT_RULESETS = /Upgrade to GitHub Pro or make this repository public/;
function branchRules(gh, repo, branch) {
  try {
    return JSON.parse(gh(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`]));
  } catch (err) {
    if (PLAN_WITHOUT_RULESETS.test(String(err?.stderr ?? "") + String(err?.message ?? ""))) return [];
    throw err;
  }
}

// One read of the PR as the babysitter sees it: head, base, merge state, checks on the
// head (latest run per producer), required check names, and the feedback still on the PR.
export function observe(gh, repo, number) {
  const [owner, name] = repo.split("/");
  const data = graphql(gh, CORE, { owner, name, number });
  const viewer = data.viewer;
  const pr = pullRequestOf(data);
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts ?? { nodes: [], pageInfo: { hasNextPage: false } };
  if (contexts.pageInfo.hasNextPage) throw new Error("more than 100 checks on the head; read them with gh pr checks");
  const reported = contexts.nodes.map(check);
  const latest = new Map();
  // The newest report stands. Two reports of the same moment cannot be ordered, so a failing
  // one wins: a check is never green while one of its newest reports fails.
  for (const c of reported.filter((x) => !x.actions)) {
    const held = latest.get(c.identity);
    if (!held || c.order > held.order || (c.order === held.order && c.status === "fail")) latest.set(c.identity, { ...c, attempt: null });
  }
  const checks = [...latest.values(), ...actionsJobs(gh, repo, reported.filter((x) => x.actions))]
    .map(({ identity, order, actions, execution, ...c }) => c);
  const rules = branchRules(gh, repo, pr.baseRefName);
  const required = new Set(pr.baseRef?.refUpdateRule?.requiredStatusCheckContexts ?? []);
  for (const rule of rules) if (rule.type === "required_status_checks") for (const c of rule.parameters.required_status_checks) required.add(c.context);

  const feedback = [];
  for (const t of all(gh, repo, number, "reviewThreads")) {
    const comments = threadComments(gh, t).filter((c) => !ours(c, viewer.login));
    if (!comments.length) continue;
    feedback.push({ id: t.id, kind: "thread", resolved: t.isResolved, path: t.path, line: t.line, outdated: t.isOutdated, url: comments[0].url,
      comments: comments.map((c) => ({ author: c.author?.login ?? null, body: c.body })), fingerprint: fingerprint(comments.map((c) => [c.id, c.body])) });
  }
  for (const [kind, connection] of [["comment", "comments"], ["review", "reviews"]]) {
    for (const c of all(gh, repo, number, connection)) {
      if (!c.body?.trim() || ours(c, viewer.login)) continue;
      feedback.push({ id: c.id, kind, author: c.author?.login ?? null, url: c.url, body: c.body, fingerprint: fingerprint(c.body) });
    }
  }
  return {
    number: pr.number, url: pr.url, state: pr.state, draft: pr.isDraft, head_ref: pr.headRefName, head: pr.headRefOid,
    base_ref: pr.baseRefName, base: pr.baseRef?.target?.oid ?? null, mergeable: pr.mergeable, merge_state: pr.mergeStateStatus,
    review_decision: pr.reviewDecision, checks, required: [...required], feedback,
  };
}

// Decides what the babysitter does next from one observation and the durable state.
// Order is fixed: feedback, then CI on the current head, then branch currency, then wait.
export function evaluate(state, seen, now) {
  const invalidated = [];
  const headMoved = state.head != null && state.head.sha !== seen.head;
  if (state.head?.sha !== seen.head) {
    if (state.head) {
      if (Object.keys(state.ci ?? {}).length) invalidated.push("ci results");
      if (state.ready_candidate) invalidated.push("ready candidate");
    }
    state.head = { sha: seen.head, since: new Date(now).toISOString() };
    state.ci = {};
    state.ready_candidate = null;
  }
  state.handled ??= {};
  // A resolved thread is feedback only when this babysitter handled it and it changed since:
  // a reply or edit after the resolve. Threads others resolved stay closed.
  const pending = seen.feedback.filter((f) => state.handled[f.id]?.fingerprint !== f.fingerprint && (!f.resolved || state.handled[f.id]));
  // Count each reopen of a thread, so a park can tell a resolve that followed it.
  state.threads ??= {};
  for (const f of seen.feedback.filter((x) => x.kind === "thread")) {
    const known = state.threads[f.id];
    if (!known) state.threads[f.id] = { resolved: f.resolved, reopens: 0 };
    else {
      if (known.resolved && !f.resolved) known.reopens++;
      known.resolved = f.resolved;
    }
  }
  // A needs-human item stays parked until its thread is resolved after it was parked: it was
  // open when parked, or it was reopened since.
  const parked = seen.feedback.filter((f) => {
    const h = state.handled[f.id];
    if (h?.disposition !== "needs-human" || h.fingerprint !== f.fingerprint) return false;
    const releasedByResolve = f.resolved && (!h.resolved || state.threads[f.id].reopens > (h.reopens ?? 0));
    return !releasedByResolve;
  });

  const names = new Set(seen.checks.map((c) => c.name));
  const missing = seen.required.filter((n) => !names.has(n));
  const failing = seen.checks.filter((c) => c.status === "fail").map((c) => ({ ...c, handled: state.ci[c.key]?.outcome ?? null }));
  const running = seen.checks.filter((c) => c.status === "pending").map((c) => c.name);
  const unhandled = failing.filter((c) => !c.handled);

  const next = [];
  if (pending.length) next.push("feedback");
  if (unhandled.length) next.push("ci");
  if (["BEHIND", "DIRTY"].includes(seen.merge_state)) next.push("update-branch");

  const headAge = (now - Date.parse(state.head.since)) / 1000;
  const human = [];
  const waiting = [];
  if (seen.draft) human.push("draft");
  for (const f of parked) human.push(`needs-human: ${f.url}`);
  for (const c of failing.filter((c) => c.handled && c.handled !== "rerun")) human.push(`${c.name} failing after recover-ci: ${c.handled}`);
  if (seen.review_decision === "CHANGES_REQUESTED") human.push("changes requested");
  if (seen.review_decision === "REVIEW_REQUIRED") human.push("review required");
  for (const n of missing) (headAge >= MISSING_CHECK_GRACE_SECONDS ? human : waiting).push(`required check missing: ${n}`);
  for (const n of running) waiting.push(`check running: ${n}`);
  for (const c of failing.filter((c) => c.handled === "rerun")) waiting.push(`rerun requested: ${c.name}`);
  if (seen.mergeable !== "MERGEABLE") waiting.push(`mergeable: ${seen.mergeable}`);
  if (!["CLEAN", "HAS_HOOKS", "UNSTABLE", "BEHIND", "DIRTY"].includes(seen.merge_state) && !human.length) {
    (seen.merge_state === "BLOCKED" && !running.length && !missing.length ? human : waiting).push(`merge state: ${seen.merge_state}`);
  }

  let outcome = null;
  if (seen.state !== "OPEN") outcome = "closed";
  else if (now >= Date.parse(state.monitor.deadline_at)) outcome = "budget-exhausted";
  else if (!next.length && human.length && !waiting.length) {
    outcome = failing.some((c) => c.handled === "budget-exhausted") ? "budget-exhausted" : "blocked";
  } else if (!next.length && !human.length && !waiting.length) {
    // A head move already cleared the candidate; only the base can still change under it.
    const candidate = state.ready_candidate;
    if (candidate?.base === seen.base) {
      if ((now - Date.parse(candidate.at)) / 1000 >= SETTLE_SECONDS) outcome = "ready";
      else waiting.push("settling before ready");
    } else {
      state.ready_candidate = { base: seen.base, at: new Date(now).toISOString() };
      waiting.push("settling before ready");
    }
  }
  if (next.length || human.length || waiting.length && !waiting.includes("settling before ready")) state.ready_candidate = null;
  if (!outcome && !next.length) next.push("wait");

  return {
    outcome, next, head_moved: headMoved, invalidated,
    pr: { number: seen.number, url: seen.url, state: seen.state, draft: seen.draft, head: seen.head, base_ref: seen.base_ref, base: seen.base },
    // A thread's fingerprint carries its resolution and reopen count as the babysitter saw
    // them, so handled records that view, whatever a later snapshot saw.
    feedback: pending.map((f) => (f.kind === "thread" ? { ...f, fingerprint: `${f.fingerprint}.${f.resolved ? "resolved" : "open"}.${state.threads[f.id].reopens}` } : f)),
    checks: { failing, running, missing, passing: seen.checks.filter((c) => c.status === "pass").length, total: seen.checks.length, required: seen.required },
    branch: { merge_state: seen.merge_state, mergeable: seen.mergeable, review_decision: seen.review_decision },
    blockers: [...human, ...waiting],
    // A parked comment or review body has no resolve to release it: when a later comment
    // answers it, the babysitter records it again, with this fingerprint.
    parked: parked.filter((f) => f.kind !== "thread").map((f) => ({ id: f.id, kind: f.kind, url: f.url, fingerprint: f.fingerprint })),
  };
}

// The GitHub read happens inside the state transaction: an observation is never applied to
// state another session advanced after it was taken.
export function snapshot({ file, gh = realGh, now = Date.now() }) {
  return update(file, (state) => {
    if (state.pr == null) throw new Error("no PR bound yet: create it, then run bind");
    const report = evaluate(state, observe(gh, state.repo, state.pr), now);
    return { ...report, budgets: budgets(state, now), state_file: file };
  });
}

const DISPOSITIONS = ["fixed", "answered", "declined", "no-action", "needs-human"];

// Records that one feedback item was handled as it read at `fingerprint`. A later edit
// or reply changes the fingerprint, and the item is pending again.
export function handled(file, { id, fingerprint: seen, disposition, now = Date.now() }) {
  if (!DISPOSITIONS.includes(disposition)) throw new Error(`disposition must be one of ${DISPOSITIONS.join(", ")}`);
  if (!id || !seen) throw new Error("handled needs --id and --fingerprint from the snapshot");
  update(file, (state) => {
    state.handled ??= {};
    const thread = THREAD_SEEN.exec(seen);
    state.handled[id] = thread
      ? { fingerprint: thread[1], disposition, resolved: thread[2] === "resolved", reopens: Number(thread[3]), at: new Date(now).toISOString() }
      : { fingerprint: seen, disposition, resolved: false, at: new Date(now).toISOString() };
  });
}

const CI_OUTCOMES = ["rerun", "repaired", "stopped", "budget-exhausted"];

// Records recover-ci's outcome for one failing check run on the current head.
export function ciResult(file, { key, outcome, now = Date.now() }) {
  if (!CI_OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${CI_OUTCOMES.join(", ")}`);
  update(file, (state) => {
    if (!state.head) throw new Error("take a snapshot first");
    state.ci ??= {};
    state.ci[key] = { outcome, head: state.head.sha, at: new Date(now).toISOString() };
  });
}

const USAGE = `Usage:
  babysit-state.mjs open [--pr N] [--duration 8h] [--repo OWNER/REPO] [--branch NAME]
  babysit-state.mjs bind --state FILE --pr N
  babysit-state.mjs snapshot --state FILE
  babysit-state.mjs handled --state FILE --id ID --fingerprint FP --disposition fixed|answered|declined|no-action|needs-human
  babysit-state.mjs ci-result --state FILE --key KEY --outcome rerun|repaired|stopped|budget-exhausted
  babysit-state.mjs spend --state FILE repair|rerun [--note TEXT]
  babysit-state.mjs extend --state FILE --duration 2h`;

function main(argv) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    state: { type: "string" }, pr: { type: "string" }, duration: { type: "string" }, repo: { type: "string" }, branch: { type: "string" },
    id: { type: "string" }, fingerprint: { type: "string" }, disposition: { type: "string" }, key: { type: "string" },
    outcome: { type: "string" }, note: { type: "string" },
  } });
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const pr = values.pr == null ? null : Number(values.pr);
  if (pr != null && !Number.isInteger(pr)) throw new Error(`--pr must be a PR number: ${values.pr}`);
  if (command !== "open" && !values.state) throw new Error(`--state FILE is required\n${USAGE}`);
  switch (command) {
    case "open": {
      const repo = values.repo ?? realGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
      const dir = join(resolve(git("rev-parse", "--git-common-dir")), "supermatt", "babysit-pr");
      const branch = values.branch ?? (pr == null ? git("branch", "--show-current") : undefined);
      if (pr == null && !branch) throw new Error("detached HEAD: check out the PR branch or pass --pr");
      return open({ dir, repo, branch, pr, duration: values.duration });
    }
    case "bind": return { bound: pr, stateFile: bind(values.state, pr) };
    case "snapshot": return snapshot({ file: values.state });
    case "handled": handled(values.state, values); return { handled: values.id };
    case "ci-result": ciResult(values.state, values); return { recorded: values.key };
    case "spend": return spend(values.state, positionals[0], { note: values.note });
    case "extend": return extend(values.state, values.duration);
    default: throw new Error(USAGE);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error instanceof BudgetExhausted ? 3 : 1;
  }
}
