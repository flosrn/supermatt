import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocal, pick, only } from "../skills/orchestrate/scripts/next-issue.mjs";

const issue = (number, { state = "open", labels = ["ready-for-agent"], body = "", author = "OWNER", ...extra } = {}) => ({
  number, title: `t${number}`, state, body,
  labels: labels.map((name) => ({ name })), assignees: [], author_association: author,
  issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 },
  ...extra,
});

const picked = (issues) => pick(issues, "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy");
const numbers = (issues) => picked(issues).map((i) => i.number);
const scoped = (issues, keys) => only(issues, keys, "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy");

test("only keeps named keys in queue order and collapses duplicates", () => {
  const result = scoped([issue(36), issue(35), issue(34)], ["35", "34", "35"]);
  assert.deepEqual(result.issues.map(i => [i.number, i.stage, i.tier]), [[34, "ready", "none"], [35, "ready", "none"]]);
  assert.deepEqual(result.skipped, []);
});

test("only explains missing refs in requested order with skip precedence", () => {
  const result = scoped([
    issue(1, { pull_request: {}, state: "closed", assignees: [{}] }),
    issue(2, { state: "closed", assignees: [{}], issue_dependencies_summary: { blocked_by: 1 }, labels: [] }),
    issue(3, { assignees: [{}], issue_dependencies_summary: { blocked_by: 1 }, labels: [] }),
    issue(4, { issue_dependencies_summary: { blocked_by: 1 }, labels: [] }),
    issue(5, { body: "Blocked by: #9" }),
    issue(6, { labels: [] }),
    issue(7, { labels: ["needs-triage"], author: "NONE" }),
    issue(8, { body: "", labels: ["ready-for-agent"] }),
    issue(9, { body: "## Parent\n\n#8", labels: [] }),
  ], ["99", "1", "2", "3", "5", "4", "6", "7", "8", "99"]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.skipped, [
    { key: "99", reason: "not found" },
    { key: "1", reason: "not found" },
    { key: "2", reason: "closed" },
    { key: "3", reason: "assigned" },
    { key: "5", reason: "blocked" },
    { key: "4", reason: "blocked" },
    { key: "6", reason: "not at any stage" },
    { key: "7", reason: "not at any stage" },
    { key: "8", reason: "not at any stage" },
  ]);
});

test("one mapped light tier label gives the light tier", () => {
  const queue = picked([issue(1, { labels: ["ready-for-agent", "tier:light"] })]);
  assert.equal(queue[0].tier, "light");
});

test("one mapped standard tier label gives the standard tier", () => {
  const queue = picked([issue(1, { labels: ["ready-for-agent", "tier:standard"] })]);
  assert.equal(queue[0].tier, "standard");
});

test("one mapped heavy tier label gives the heavy tier", () => {
  const queue = picked([issue(1, { labels: ["ready-for-agent", "tier:heavy"] })]);
  assert.equal(queue[0].tier, "heavy");
});

test("two distinct mapped tier labels give an invalid tier", () => {
  const queue = picked([issue(1, { labels: ["ready-for-agent", "tier:light", "tier:heavy"] })]);
  assert.equal(queue[0].tier, "invalid");
});

test("an unmapped tier prefix label is ignored", () => {
  assert.deepEqual(picked([
    issue(1, { labels: ["ready-for-agent", "tier:unknown"] }),
    issue(2, { labels: ["ready-for-agent", "tier:light", "tier:unknown"] }),
  ]).map((i) => [i.number, i.tier]), [[1, "none"], [2, "light"]]);
});

test("an issue without a mapped tier label gives no tier", () => {
  const queue = picked([issue(1)]);
  assert.equal(queue[0].tier, "none");
});

test("GitHub tiers use configured nondefault label mappings", () => {
  const queue = pick([
    issue(1, { labels: ["agent-ready", "size:s"] }),
    issue(2, { labels: ["agent-ready", "size:m"] }),
    issue(3, { labels: ["agent-ready", "size:l"] }),
    issue(4, { labels: ["agent-ready", "tier:light"] }),
    issue(5, { labels: ["agent-ready", "size:s", "size:l"] }),
  ], "agent-ready", "defect", "investigate", "size:s", "size:m", "size:l");
  assert.deepEqual(queue.map((i) => [i.number, i.tier]), [
    [1, "light"], [2, "standard"], [3, "heavy"], [4, "none"], [5, "invalid"],
  ]);
});

for (const tier of ["light", "standard", "heavy"]) {
  test(`${tier} tier preserves queue stages, filtering and ordering`, () => {
    const labels = (...names) => [...names, `tier:${tier}`];
    const queue = picked([
      issue(8, { labels: labels("enhancement", "needs-triage") }),
      issue(9, { labels: labels("bug", "ready-for-agent") }),
      issue(2, { labels: labels("ready-for-agent") }),
      issue(10, { labels: labels("bug", "needs-triage") }),
      issue(1, { labels: labels(), sub_issues_summary: { total: 1, completed: 1 } }),
      issue(3, { labels: labels("enhancement", "needs-triage") }),
      issue(11, { labels: labels("ready-for-agent"), state: "closed" }),
      issue(12, { labels: labels() }),
      issue(13, { labels: labels("ready-for-agent"), assignees: [{ login: "x" }] }),
      issue(14, { labels: labels("ready-for-agent"), pull_request: {} }),
      issue(15, { labels: labels("ready-for-agent"), issue_dependencies_summary: { blocked_by: 1 } }),
      issue(16, { labels: labels("ready-for-agent"), sub_issues_summary: { total: 2 } }),
      issue(17, { labels: labels("bug", "needs-triage"), author: "NONE" }),
      issue(18, { labels: labels("ready-for-agent"), body: "Blocked by: #12" }),
    ]);
    assert.deepEqual(queue.map((i) => [i.number, i.stage]), [
      [1, "spec"], [9, "ready"], [10, "triage"], [2, "ready"], [3, "triage"], [8, "triage"],
    ]);
    assert.deepEqual(queue.map((i) => i.tier), [tier, tier, tier, tier, tier, tier]);
  });
}

test("a spec carries its mapped tier", () => {
  const queue = picked([
    issue(10, { labels: ["tier:heavy"], sub_issues_summary: { total: 2, completed: 2 } }),
  ]);
  assert.deepEqual(queue.map((i) => [i.number, i.stage, i.tier]), [[10, "spec", "heavy"]]);
});

test("mixed tiers preserve spec and bug rank ahead of lighter issues", () => {
  const queue = picked([
    issue(1, { labels: ["ready-for-agent", "tier:light"] }),
    issue(2, { labels: ["bug", "ready-for-agent", "tier:standard"] }),
    issue(10, { labels: ["tier:heavy"], sub_issues_summary: { total: 1, completed: 1 } }),
  ]);
  assert.deepEqual(queue.map(i => [i.number, i.stage, i.tier]), [
    [10, "spec", "heavy"], [2, "ready", "standard"], [1, "ready", "light"],
  ]);
});

test("lower issue numbers precede lighter tiers even with invalid or heavy tiers", () => {
  const queue = picked([
    issue(3, { labels: ["ready-for-agent", "tier:light"] }),
    issue(2, { labels: ["ready-for-agent", "tier:heavy"] }),
    issue(1, { labels: ["ready-for-agent", "tier:light", "tier:heavy"] }),
  ]);
  assert.deepEqual(queue.map(i => [i.number, i.tier]), [[1, "invalid"], [2, "heavy"], [3, "light"]]);
});

test("names the stage of each issue", () => {
  const issues = [issue(1), issue(2, { labels: ["bug", "needs-triage"] }), issue(3, { labels: [], sub_issues_summary: { total: 1, completed: 1 } })];
  assert.deepEqual(picked(issues).map((i) => [i.number, i.stage]), [[3, "spec"], [2, "triage"], [1, "ready"]]);
});

test("a spec whose sub-issues are all done comes before bugs", () => {
  const spec = issue(10, { labels: [], sub_issues_summary: { total: 2, completed: 2 } });
  assert.deepEqual(numbers([issue(1), issue(4, { labels: ["bug", "ready-for-agent"] }), spec]), [10, 4, 1]);
});

test("a spec named as parent waits for its open children", () => {
  const spec = issue(10, { labels: [] });
  assert.deepEqual(numbers([spec, issue(11, { body: "## Parent\n\n#10" }), issue(12, { state: "closed", body: "## Parent\n\n#10" })]), [11]);
  assert.deepEqual(numbers([spec, issue(11, { state: "closed", body: "## Parent\n\n#10" })]), [10]);
});

test("drops specs with open sub-issues and specs from outsiders", () => {
  assert.deepEqual(numbers([
    issue(10, { labels: [], sub_issues_summary: { total: 2, completed: 1 } }),
    issue(11, { labels: [], author: "NONE", sub_issues_summary: { total: 1, completed: 1 } }),
  ]), []);
});

test("keeps ready issues lowest first", () => {
  assert.deepEqual(numbers([issue(3), issue(2)]), [2, 3]);
});

test("bugs come first, lowest first", () => {
  assert.deepEqual(numbers([issue(1), issue(2), issue(5, { labels: ["bug", "ready-for-agent"] }), issue(4, { labels: ["bug", "ready-for-agent"] })]), [4, 5, 1, 2]);
});

test("keeps untriaged bugs from the repo team", () => {
  assert.deepEqual(numbers([issue(1), issue(3, { labels: ["bug", "needs-triage"], author: "COLLABORATOR" })]), [3, 1]);
});

test("keeps team TRIAGE enhancements while dropping outsider bugs and enhancements", () => {
  assert.deepEqual(numbers([
    issue(1),
    issue(2, { labels: ["bug", "needs-triage"], author: "NONE" }),
    issue(3, { labels: ["enhancement", "needs-triage"] }),
    issue(5, { labels: ["enhancement", "needs-triage"], author: "CONTRIBUTOR" }),
    issue(4, { labels: ["bug", "needs-info"] }),
  ]), [1, 3]);
});

test("team TRIAGE enhancements follow specs and all bugs, with other issues lowest first", () => {
  assert.deepEqual(picked([
    issue(8, { labels: ["enhancement", "needs-triage"] }),
    issue(9, { labels: ["bug", "ready-for-agent"] }),
    issue(2),
    issue(10, { labels: ["bug", "needs-triage"] }),
    issue(1, { labels: [], sub_issues_summary: { total: 1, completed: 1 } }),
    issue(3, { labels: ["enhancement", "needs-triage"] }),
  ]).map(i => [i.number, i.stage]), [
    [1, "spec"], [9, "ready"], [10, "triage"], [2, "ready"], [3, "triage"], [8, "triage"],
  ]);
});

test("keeps uncategorized team TRIAGE issues", () => {
  assert.deepEqual(picked([issue(1, { labels: ["needs-triage"] })]).map(i => [i.number, i.stage]), [[1, "triage"]]);
});

test("OWNER, MEMBER and COLLABORATOR can file TRIAGE enhancements", () => {
  for (const author of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.deepEqual(picked([issue(1, { labels: ["enhancement", "needs-triage"], author })]).map(i => [i.number, i.stage]), [[1, "triage"]], author);
  }
});

test("READY takes precedence over TRIAGE for bugs and enhancements", () => {
  assert.deepEqual(picked([
    issue(1, { labels: ["enhancement", "ready-for-agent", "needs-triage"] }),
    issue(2, { labels: ["bug", "ready-for-agent", "needs-triage"] }),
  ]).map(i => [i.number, i.stage]), [[2, "ready"], [1, "ready"]]);
});

test("drops closed, unlabelled, assigned, and pull requests", () => {
  assert.deepEqual(numbers([
    issue(1, { state: "closed" }),
    issue(2, { labels: [] }),
    issue(3, { assignees: [{ login: "x" }] }),
    issue(4, { pull_request: {} }),
  ]), []);
});

test("drops native blockers and parents with sub-issues", () => {
  assert.deepEqual(numbers([
    issue(1, { issue_dependencies_summary: { blocked_by: 1 } }),
    issue(2, { sub_issues_summary: { total: 2 } }),
  ]), []);
});

test("drops issues named as a parent", () => {
  assert.deepEqual(numbers([issue(1), issue(2, { body: "## Parent\n\n#1" })]), [2]);
});

test("a Blocked by line counts only open blockers", () => {
  const issues = [
    issue(1, { state: "closed" }),
    issue(2, { labels: [] }),
    issue(3, { body: "Blocked by: #1" }),
    issue(4, { body: "Blocked by: #1, #2" }),
  ];
  assert.deepEqual(numbers(issues), [3]);
});

test("missing summaries and body are treated as empty", () => {
  const bare = issue(1, { body: null });
  delete bare.issue_dependencies_summary;
  delete bare.sub_issues_summary;
  assert.deepEqual(numbers([bare]), [1]);
});

test("GitHub database IDs do not replace issue numbers in relationships", () => {
  assert.deepEqual(numbers([
    issue(10, { id: 9000, labels: [] }),
    issue(11, { id: 9001, state: "closed", body: "## Parent\n\n#10" }),
    issue(12, { id: 9002, body: "Blocked by: #10" }),
  ]), [10]);
});

function localTracker(t, files) {
  const root = mkdtempSync(join(tmpdir(), "local-issues-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

test("local queues preserve feature identity, blockers, triage and spec priority", (t) => {
  const root = localTracker(t, {
    "alpha/spec.md": "# Alpha\n",
    "alpha/issues/01-first.md": "# 01: First\nStatus: ready-for-agent\nClosed: 2026-10-12\n",
    "beta/spec.md": "# Beta\n",
    "beta/issues/01-first.md": "# 01: First\nStatus: ready-for-agent\n",
    "beta/issues/02-next.md": "# 02: Next\nStatus: ready-for-agent\nBlocked by: 01\n",
    "gamma/issues/01-bug.md": "# 01: Bug\nStatus: needs-triage\nCategory: bug\n",
    "gamma/issues/02-ready.md": "# 02: Ready\nStatus: ready-for-agent\nBlocked by: 03\n",
    "gamma/issues/03-done.md": "# 03: Done\nStatus: ready-for-agent\nClosed: 2026-10-12\n",
    "gamma/issues/04-assigned.md": "# 04: Assigned\nStatus: ready-for-agent\nAssignee: someone\n",
    "gamma/issues/05-draft.md": "# 05: Draft\nStatus: needs-info\n",
    "gamma/decisions/01-question.md": "# Question\nStatus: ready-for-agent\n",
    "empty/spec.md": "# No tickets yet\n",
  });
  const queue = picked(loadLocal(root, root));
  assert.deepEqual(queue.map(i => [i.localPath, i.stage]), [
    ["alpha/spec.md", "spec"], ["gamma/issues/01-bug.md", "triage"],
    ["beta/issues/01-first.md", "ready"], ["gamma/issues/02-ready.md", "ready"],
  ]);
  assert.equal(queue[1].title, "Bug");
});

test("local metadata supports configured labels, CRLF, and closed specs", (t) => {
  const root = localTracker(t, {
    "feature/spec.md": "# Spec\r\nClosed: 2026-10-12\r\n",
    "feature/issues/01-done.md": "# Done\r\nStatus: closed\r\n",
    "feature/issues/02-fix.md": "# Fix\r\nStatus: investigate\r\nCategory: defect\r\nBlocked by: 01\r\n",
  });
  assert.deepEqual(pick(loadLocal(root, root), "agent-ready", "defect", "investigate", "tier:light", "tier:standard", "tier:heavy").map(i => [i.localPath, i.stage]), [
    ["feature/issues/02-fix.md", "triage"],
  ]);
});

for (const tier of ["light", "standard", "heavy"]) {
  test(`local Tier metadata gives the ${tier} tier`, (t) => {
    const root = localTracker(t, {
      "feature/issues/01-work.md": `# Work\nStatus: ready-for-agent\nTier: tier:${tier}\n`,
    });
    assert.deepEqual(picked(loadLocal(root, root)).map(i => [i.stage, i.tier]), [["ready", tier]]);
  });
}

test("local issues without Tier metadata give no tier", (t) => {
  const root = localTracker(t, {
    "feature/issues/01-work.md": "# Work\nStatus: ready-for-agent\n",
  });
  assert.deepEqual(picked(loadLocal(root, root)).map(i => i.tier), ["none"]);
});

for (const [name, metadata] of [
  ["repeated identical", "Tier: tier:light\nTier: tier:light\n"],
  ["repeated different", "Tier: tier:light\nTier: tier:heavy\n"],
  ["unknown", "Tier: tier:unknown\n"],
  ["empty", "Tier:\n"],
]) {
  test(`local ${name} Tier metadata gives an invalid tier`, (t) => {
    const root = localTracker(t, {
      "feature/issues/01-work.md": `# Work\nStatus: ready-for-agent\n${metadata}`,
    });
    assert.deepEqual(picked(loadLocal(root, root)).map(i => i.tier), ["invalid"]);
  });
}

test("local Tier metadata is collected only before the first second-level heading", (t) => {
  const root = localTracker(t, {
    "feature/issues/01-work.md": "# Work\nStatus: ready-for-agent\nTier: tier:standard\n## Details\nTier: tier:heavy\n",
    "feature/issues/02-work.md": "# Work\nStatus: ready-for-agent\n## Details\nTier: tier:light\n",
    "feature/issues/03-work.md": "# Work\nStatus: ready-for-agent\n## Details\nTier:\nTier: tier:unknown\n",
  });
  assert.deepEqual(picked(loadLocal(root, root)).map(i => [i.number, i.tier]), [
    [1, "standard"], [2, "none"], [3, "none"],
  ]);
});

test("local Category values matching tier mappings do not supply or invalidate a tier", (t) => {
  const root = localTracker(t, {
    "feature/issues/01-work.md": "# Work\nStatus: ready-for-agent\nCategory: tier:heavy\n",
    "feature/issues/02-work.md": "# Work\nStatus: ready-for-agent\nCategory: tier:heavy\nTier: tier:light\n",
  });
  assert.deepEqual(picked(loadLocal(root, root)).map(i => [i.number, i.tier]), [[1, "none"], [2, "light"]]);
});

test("local Status values matching tier mappings do not supply or invalidate a tier", (t) => {
  const root = localTracker(t, {
    "feature/issues/01-work.md": "# Work\nStatus: tier:light\n",
    "feature/issues/02-work.md": "# Work\nStatus: tier:light\nTier: tier:heavy\n",
  });
  assert.deepEqual(pick(loadLocal(root, root), "tier:light", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy")
    .map(i => [i.number, i.stage, i.tier]), [[1, "ready", "none"], [2, "ready", "heavy"]]);
});

test("local Tier metadata supports configured strings and CRLF", (t) => {
  const root = localTracker(t, {
    "feature/issues/01-work.md": "# Work\r\nStatus: agent-ready\r\nTier: Small change\r\n",
    "feature/issues/02-work.md": "# Work\r\nStatus: agent-ready\r\nTier: Normal change\r\n",
    "feature/issues/03-work.md": "# Work\r\nStatus: agent-ready\r\nTier: Major change\r\n",
    "feature/issues/04-work.md": "# Work\r\nStatus: agent-ready\r\nTier: tier:light\r\n",
  });
  assert.deepEqual(pick(loadLocal(root, root), "agent-ready", "defect", "investigate", "Small change", "Normal change", "Major change")
    .map(i => [i.number, i.tier]), [[1, "light"], [2, "standard"], [3, "heavy"], [4, "invalid"]]);
});

test("local mixed tiers preserve number and path ordering instead of tier ordering", (t) => {
  const root = localTracker(t, {
    "zeta/issues/02-light.md": "# Light\nStatus: ready-for-agent\nTier: tier:light\n",
    "alpha/issues/02-heavy.md": "# Heavy\nStatus: ready-for-agent\nTier: tier:heavy\n",
    "alpha/issues/01-invalid.md": "# Invalid\nStatus: ready-for-agent\nTier: unknown\n",
    "alpha/issues/03-light.md": "# Later light\nStatus: ready-for-agent\nTier: tier:light\n",
  });
  assert.deepEqual(picked(loadLocal(root, root)).map(i => [i.localPath, i.tier]), [
    ["alpha/issues/01-invalid.md", "invalid"],
    ["alpha/issues/02-heavy.md", "heavy"],
    ["zeta/issues/02-light.md", "light"],
    ["alpha/issues/03-light.md", "light"],
  ]);
});

test("local Tier values never supply category or stage labels", (t) => {
  const root = localTracker(t, {
    "feature/issues/01-tier-bug.md": "# Not a bug\nStatus: ready-for-agent\nTier: bug\n",
    "feature/issues/09-category-bug.md": "# Actual bug\nStatus: ready-for-agent\nCategory: bug\nTier: needs-triage\n",
    "feature/issues/03-tier-ready.md": "# Not ready\nTier: ready-for-agent\n",
    "feature/issues/04-triage.md": "# Still triage\nStatus: needs-triage\nTier: ready-for-agent\n",
    "feature/issues/05-tier-triage.md": "# Not triage\nTier: needs-triage\n",
  });
  const issues = loadLocal(root, root);
  assert.deepEqual(issues.map(i => [i.number, i.labels.map(label => label.name)]).sort((a, b) => a[0] - b[0]), [
    [1, ["ready-for-agent"]], [3, []], [4, ["needs-triage"]], [5, []],
    [9, ["ready-for-agent", "bug"]],
  ]);
  assert.deepEqual(picked(issues).map(i => [i.number, i.stage, i.tier]), [
    [9, "ready", "invalid"], [1, "ready", "invalid"], [4, "triage", "invalid"],
  ]);
});

test("local heavy spec retains its tier in the queue and four-column CLI output", (t) => {
  const root = localTracker(t, {
    ".scratch/feature/spec.md": "# Verify feature\nTier: tier:heavy\n",
    ".scratch/feature/issues/01-done.md": "# Done\nStatus: closed\n",
  });
  assert.deepEqual(picked(loadLocal(join(root, ".scratch"), root)).map(i => [i.localPath, i.stage, i.tier]), [
    [".scratch/feature/spec.md", "spec", "heavy"],
  ]);
  const script = fileURLToPath(new URL("../skills/orchestrate/scripts/next-issue.mjs", import.meta.url));
  const result = execFileSync(process.execPath, [script, "--local", ".scratch", "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy"], {
    cwd: root, env: { ...process.env, PATH: "" }, encoding: "utf8",
  });
  assert.equal(result, ".scratch/feature/spec.md\tVerify feature\tspec\theavy\n");
});

test("local TRIAGE enhancements share number and path ordering with ready issues", (t) => {
  const root = localTracker(t, {
    "zeta/issues/01-enhancement.md": "# Enhancement\nStatus: needs-triage\nCategory: enhancement\n",
    "alpha/issues/01-ready.md": "# Ready\nStatus: ready-for-agent\n",
    "alpha/issues/02-uncategorized.md": "# Uncategorized\nStatus: needs-triage\n",
    "alpha/issues/03-bug.md": "# Bug\nStatus: needs-triage\nCategory: bug\n",
  });
  assert.deepEqual(picked(loadLocal(root, root)).map(i => [i.localPath, i.stage]), [
    ["alpha/issues/03-bug.md", "triage"],
    ["alpha/issues/01-ready.md", "ready"],
    ["zeta/issues/01-enhancement.md", "triage"],
    ["alpha/issues/02-uncategorized.md", "triage"],
  ]);
});

test("local queues fail on missing or ambiguous blockers instead of releasing them", (t) => {
  for (const files of [
    { "feature/issues/01-first.md": "# First\nStatus: ready-for-agent\nBlocked by: 99\n" },
    { "feature/issues/01-first.md": "# First\nStatus: ready-for-agent\n", "feature/issues/01-duplicate.md": "# Duplicate\nStatus: ready-for-agent\n" },
    { "feature/issues/01-first.md": "# First\nStatus: ready-for-agent\nBlocked by: elsewhere/02\n" },
  ]) {
    const root = localTracker(t, files);
    assert.throws(() => loadLocal(root, root), /blocker|Duplicate/);
  }
});

test("local CLI uses Markdown without calling gh and preserves paths with spaces", (t) => {
  const root = localTracker(t, {
    ".scratch/my feature/issues/00-enhancement.md": "# Enhancement\nStatus: needs-triage\nCategory: enhancement\nTier: tier:light\n",
    ".scratch/my feature/issues/01-first.md": "# 01: First\nStatus: ready-for-agent\nTier: tier:standard\n",
    ".scratch/my feature/issues/02-next.md": "# 02: Next\nStatus: ready-for-agent\nBlocked by: 01\nTier: tier:heavy\n",
    ".scratch/my feature/issues/03-untiered.md": "# Untiered\nStatus: ready-for-agent\n",
    ".scratch/my feature/issues/04-invalid.md": "# Invalid\nStatus: ready-for-agent\nTier: unknown\n",
  });
  const script = fileURLToPath(new URL("../skills/orchestrate/scripts/next-issue.mjs", import.meta.url));
  const args = [script, "--local", ".scratch", "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy"];
  const run = () => execFileSync(process.execPath, args, { cwd: root, env: { ...process.env, PATH: "" }, encoding: "utf8" });
  const tail = ".scratch/my feature/issues/03-untiered.md\tUntiered\tready\tnone\n.scratch/my feature/issues/04-invalid.md\tInvalid\tready\tinvalid\n";
  assert.equal(run(), ".scratch/my feature/issues/00-enhancement.md\tEnhancement\ttriage\tlight\n.scratch/my feature/issues/01-first.md\tFirst\tready\tstandard\n" + tail);
  writeFileSync(join(root, ".scratch/my feature/issues/00-enhancement.md"), "# Enhancement\nStatus: needs-triage\nCategory: enhancement\nClosed: 2026-10-12\n");
  assert.equal(run(), ".scratch/my feature/issues/01-first.md\tFirst\tready\tstandard\n" + tail);
  writeFileSync(join(root, ".scratch/my feature/issues/01-first.md"), "# First\nStatus: ready-for-agent\nClosed: 2026-10-12\n");
  assert.equal(run(), ".scratch/my feature/issues/02-next.md\tNext\tready\theavy\n" + tail);
});

for (const count of [0, 3, 5, 7]) {
  test(`CLI rejects ${count} mapping arguments with usage and status 1`, (t) => {
    const root = localTracker(t, {});
    const script = fileURLToPath(new URL("../skills/orchestrate/scripts/next-issue.mjs", import.meta.url));
    const mappings = ["ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy", "extra"];
    const result = spawnSync(process.execPath, [script, ...mappings.slice(0, count)], {
      cwd: root, env: { ...process.env, PATH: "" }, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "usage: next-issue.mjs [--local ROOT] [--only KEY[,KEY...]] READY BUG TRIAGE LIGHT STANDARD HEAVY\n");
  });
}

for (const [name, localArgs] of [
  ["missing", ["--local"]],
  ["missing before mappings", ["--local", "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy"]],
  ["empty", ["--local", "", "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy"]],
  ["blank", ["--local", " \t ", "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy"]],
]) {
  test(`local CLI rejects a ${name} root with usage and status 1`, (t) => {
    const root = localTracker(t, {});
    const script = fileURLToPath(new URL("../skills/orchestrate/scripts/next-issue.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, ...localArgs], {
      cwd: root, env: { ...process.env, PATH: "" }, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "usage: next-issue.mjs [--local ROOT] [--only KEY[,KEY...]] READY BUG TRIAGE LIGHT STANDARD HEAVY\n");
  });
}

test("local CLI accepts exactly six mapping arguments", (t) => {
  const root = localTracker(t, {
    ".scratch/feature/issues/01-work.md": "# Work\nStatus: agent-ready\nTier: Normal change\n",
  });
  const script = fileURLToPath(new URL("../skills/orchestrate/scripts/next-issue.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--local", ".scratch", "agent-ready", "defect", "investigate", "Small change", "Normal change", "Major change"], {
    cwd: root, env: { ...process.env, PATH: "" }, encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, ".scratch/feature/issues/01-work.md\tWork\tready\tstandard\n");
});

for (const onlyFirst of [false, true]) {
  test(`local CLI scopes two bugs and reports skips with --only ${onlyFirst ? "before" : "after"} --local`, (t) => {
    const root = localTracker(t, {
      ".scratch/feature/issues/01-bug.md": "# First bug\nStatus: ready-for-agent\nCategory: bug\nTier: tier:light\n",
      ".scratch/feature/issues/02-bug.md": "# Second bug\nStatus: needs-triage\nCategory: bug\nTier: tier:heavy\n",
      ".scratch/feature/issues/03-ready.md": "# Unnamed\nStatus: ready-for-agent\n",
      ".scratch/feature/issues/04-closed.md": "# Closed\nStatus: closed\n",
    });
    const script = fileURLToPath(new URL("../skills/orchestrate/scripts/next-issue.mjs", import.meta.url));
    const onlyArgs = ["--only", ".scratch/feature/issues/02-bug.md,.scratch/feature/issues/04-closed.md,.scratch/missing.md,.scratch/feature/issues/01-bug.md,.scratch/missing.md"];
    const localArgs = ["--local", ".scratch"];
    const result = spawnSync(process.execPath, [script, ...(onlyFirst ? [...onlyArgs, ...localArgs] : [...localArgs, ...onlyArgs]),
      "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy"], {
      cwd: root, env: { ...process.env, PATH: "" }, encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, ".scratch/feature/issues/01-bug.md\tFirst bug\tready\tlight\n.scratch/feature/issues/02-bug.md\tSecond bug\ttriage\theavy\n");
    assert.equal(result.stderr, "skipped\t.scratch/feature/issues/04-closed.md\tclosed\nskipped\t.scratch/missing.md\tnot found\n");
  });
}

for (const [name, filterArgs] of [
  ["missing", ["--only"]],
  ["missing before mappings", ["--only", "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy"]],
  ["empty", ["--only", "", "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy"]],
  ["empty element", ["--only", "34,,35", "ready-for-agent", "bug", "needs-triage", "tier:light", "tier:standard", "tier:heavy"]],
]) {
  test(`CLI rejects a ${name} --only value with usage and status 1`, (t) => {
    const root = localTracker(t, {});
    const script = fileURLToPath(new URL("../skills/orchestrate/scripts/next-issue.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--local", root, ...filterArgs], {
      cwd: root, env: { ...process.env, PATH: "" }, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "usage: next-issue.mjs [--local ROOT] [--only KEY[,KEY...]] READY BUG TRIAGE LIGHT STANDARD HEAVY\n");
  });
}
