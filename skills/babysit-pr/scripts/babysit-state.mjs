#!/usr/bin/env node
// Durable state for babysit-pr: which PR this branch babysits, the monitoring deadline,
// the CI recovery counters, handled feedback, and evidence tied to the current head.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const realGh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const fileFor = (dir, repo, branch) => join(dir, `${repo}#${branch}`.replace(/[^A-Za-z0-9._-]+/g, "-") + ".json");

function load(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function save(file, state) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n");
  renameSync(temp, file);
}

function update(file, change) {
  const state = load(file);
  const result = change(state);
  save(file, state);
  return result;
}

const LIMITS = { repair: 2, rerun: 1 };
const DEFAULT_DURATION = "8h";

// "8h", "90m", "1h30m", "45s", or a bare number of seconds.
export function parseDuration(text) {
  const value = String(text).trim();
  if (/^\d+$/.test(value)) return Number(value);
  const parts = [...value.matchAll(/(\d+)([hms])/g)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== value) throw new Error(`bad duration: ${text}`);
  return parts.reduce((sum, [, n, unit]) => sum + Number(n) * { h: 3600, m: 60, s: 1 }[unit], 0);
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

// Finds the PR to babysit, or says one must be created. A PR once bound stays bound:
// when it is closed or merged the outcome is closed, never a second PR for the branch.
// The monitoring deadline and recovery counters are set when the state is created; a
// resume keeps them, whatever duration it passes. Naming a different PR starts a new state.
export function open({ dir, gh = realGh, repo, branch, pr = null, duration = DEFAULT_DURATION, now = Date.now() }) {
  if (pr != null) branch = viewPr(gh, repo, pr).headRefName;
  mkdirSync(dir, { recursive: true });
  const stateFile = fileFor(dir, repo, branch);
  let state = existsSync(stateFile) ? load(stateFile) : null;
  const resumed = state != null && (pr == null || state.pr == null || state.pr === pr);
  if (!resumed) state = fresh({ repo, branch, now, duration });
  if (pr != null) state.pr = pr;

  let action;
  if (state.pr != null) {
    action = viewPr(gh, repo, state.pr).state === "OPEN" ? "reuse" : "closed";
  } else {
    const openPrs = JSON.parse(gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url,state,headRefName"]));
    if (openPrs.length > 1) throw new Error(`several open PRs for ${branch}: ${openPrs.map((p) => p.number).join(", ")}`);
    if (openPrs.length === 1) state.pr = openPrs[0].number;
    action = openPrs.length === 1 ? "reuse" : "create";
  }
  save(stateFile, state);
  return { action, pr: state.pr, stateFile, resumed, budgets: budgets(state, now) };
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

export function bind(file, pr) {
  if (!Number.isInteger(pr)) throw new Error("bind needs --pr N");
  update(file, (state) => {
    if (state.pr != null && state.pr !== pr) throw new Error(`state already bound to PR ${state.pr}`);
    state.pr = pr;
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
// count as new feedback or change a thread's fingerprint.
export const MARKER = "<!-- supermatt:babysit-pr -->";
const SETTLE_SECONDS = 300;
const MISSING_CHECK_GRACE_SECONDS = 600;

const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const ours = (body) => (body ?? "").includes(MARKER);

const CHECKS = `contexts(first: 100) { pageInfo { hasNextPage endCursor } nodes { __typename
  ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { workflowRun { databaseId } } }
  ... on StatusContext { context state targetUrl createdAt } } }`;
const CORE = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
  number url state isDraft headRefName headRefOid baseRefName mergeable mergeStateStatus reviewDecision
  baseRef { target { oid } refUpdateRule { requiredStatusCheckContexts } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { ${CHECKS} } } } } } } }`;
const CONNECTIONS = {
  reviewThreads: "reviewThreads(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated path line comments(first: 100) { nodes { id author { login } body url } } } }",
  comments: "comments(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id author { login } body url } }",
  reviews: "reviews(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id author { login } body url state } }",
};

function graphql(gh, query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value != null) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  }
  const response = JSON.parse(gh(args));
  if (response.errors?.length) throw new Error(`GitHub GraphQL: ${response.errors.map((e) => e.message).join("; ")}`);
  const pr = response.data?.repository?.pullRequest;
  if (!pr) throw new Error("GitHub GraphQL: pull request not found");
  return pr;
}

// Reads every page of a connection: a first page alone undercounts open feedback.
function all(gh, repo, number, name) {
  const [owner, repoName] = repo.split("/");
  const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${CONNECTIONS[name]} } } }`;
  const nodes = [];
  let cursor = null;
  do {
    const page = graphql(gh, query, { owner, name: repoName, number, cursor })[name];
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return nodes;
}

function check(node) {
  if (node.__typename === "CheckRun") {
    const status = node.status !== "COMPLETED" ? "pending" : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(node.conclusion) ? "pass" : "fail";
    return { name: node.name, key: `check-run:${node.databaseId}`, status, conclusion: node.conclusion, url: node.detailsUrl, run_id: node.checkSuite?.workflowRun?.databaseId ?? null };
  }
  const status = node.state === "SUCCESS" ? "pass" : ["PENDING", "EXPECTED"].includes(node.state) ? "pending" : "fail";
  return { name: node.context, key: `status:${node.context}:${node.createdAt}`, status, conclusion: node.state, url: node.targetUrl, run_id: null };
}

// One read of the PR as the babysitter sees it: head, base, merge state, checks on the
// head (latest run per name), required check names, and the feedback still on the PR.
export function observe(gh, repo, number) {
  const [owner, name] = repo.split("/");
  const pr = graphql(gh, CORE, { owner, name, number });
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts ?? { nodes: [], pageInfo: { hasNextPage: false } };
  if (contexts.pageInfo.hasNextPage) throw new Error("more than 100 checks on the head; read them with gh pr checks");
  const latest = new Map();
  for (const c of contexts.nodes.map(check)) {
    const seen = latest.get(c.name);
    if (!seen || c.key.localeCompare(seen.key, undefined, { numeric: true }) > 0) latest.set(c.name, c);
  }
  const rules = JSON.parse(gh(["api", `repos/${repo}/rules/branches/${encodeURIComponent(pr.baseRefName)}`]));
  const required = new Set(pr.baseRef?.refUpdateRule?.requiredStatusCheckContexts ?? []);
  for (const rule of rules) if (rule.type === "required_status_checks") for (const c of rule.parameters.required_status_checks) required.add(c.context);

  const feedback = [];
  for (const t of all(gh, repo, number, "reviewThreads")) {
    const comments = t.comments.nodes.filter((c) => !ours(c.body));
    if (t.isResolved || !comments.length) continue;
    feedback.push({ id: t.id, kind: "thread", path: t.path, line: t.line, outdated: t.isOutdated, url: comments[0].url,
      comments: comments.map((c) => ({ author: c.author?.login ?? null, body: c.body })), fingerprint: fingerprint(comments.map((c) => [c.id, c.body])) });
  }
  for (const [kind, connection] of [["comment", "comments"], ["review", "reviews"]]) {
    for (const c of all(gh, repo, number, connection)) {
      if (!c.body?.trim() || ours(c.body)) continue;
      feedback.push({ id: c.id, kind, author: c.author?.login ?? null, url: c.url, body: c.body, fingerprint: fingerprint(c.body) });
    }
  }
  return {
    number: pr.number, url: pr.url, state: pr.state, draft: pr.isDraft, head_ref: pr.headRefName, head: pr.headRefOid,
    base_ref: pr.baseRefName, base: pr.baseRef?.target?.oid ?? null, mergeable: pr.mergeable, merge_state: pr.mergeStateStatus,
    review_decision: pr.reviewDecision, checks: [...latest.values()], required: [...required], feedback,
  };
}

// Decides what the babysitter does next from one observation and the durable state.
// Order is fixed: feedback, then CI on the current head, then branch currency, then wait.
export function evaluate(state, seen, now) {
  const invalidated = [];
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
  const pending = seen.feedback.filter((f) => state.handled[f.id]?.fingerprint !== f.fingerprint);
  const parked = seen.feedback.filter((f) => state.handled[f.id]?.fingerprint === f.fingerprint && state.handled[f.id].disposition === "needs-human");

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
    outcome, next, invalidated,
    pr: { number: seen.number, url: seen.url, state: seen.state, draft: seen.draft, head: seen.head, base_ref: seen.base_ref, base: seen.base },
    feedback: pending,
    checks: { failing, running, missing, passing: seen.checks.filter((c) => c.status === "pass").length, total: seen.checks.length, required: seen.required },
    branch: { merge_state: seen.merge_state, mergeable: seen.mergeable, review_decision: seen.review_decision },
    blockers: [...human, ...waiting],
  };
}

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
    state.handled[id] = { fingerprint: seen, disposition, at: new Date(now).toISOString() };
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
    case "bind": bind(values.state, pr); return { bound: pr };
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
