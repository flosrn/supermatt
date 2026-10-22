import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocal, pick } from "../skills/orchestrate/scripts/next-issue.mjs";

const issue = (number, { state = "open", labels = ["ready-for-agent"], body = "", author = "OWNER", ...extra } = {}) => ({
  number, title: `t${number}`, state, body,
  labels: labels.map((name) => ({ name })), assignees: [], author_association: author,
  issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 },
  ...extra,
});

const picked = (issues) => pick(issues, "ready-for-agent", "bug", "needs-triage");
const numbers = (issues) => picked(issues).map((i) => i.number);

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
  assert.deepEqual(pick(loadLocal(root, root), "agent-ready", "defect", "investigate").map(i => [i.localPath, i.stage]), [
    ["feature/issues/02-fix.md", "triage"],
  ]);
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
    ".scratch/my feature/issues/00-enhancement.md": "# Enhancement\nStatus: needs-triage\nCategory: enhancement\n",
    ".scratch/my feature/issues/01-first.md": "# 01: First\nStatus: ready-for-agent\n",
    ".scratch/my feature/issues/02-next.md": "# 02: Next\nStatus: ready-for-agent\nBlocked by: 01\n",
  });
  const script = fileURLToPath(new URL("../skills/orchestrate/scripts/next-issue.mjs", import.meta.url));
  const args = [script, "--local", ".scratch", "ready-for-agent", "bug", "needs-triage"];
  const run = () => execFileSync(process.execPath, args, { cwd: root, env: { ...process.env, PATH: "" }, encoding: "utf8" });
  assert.equal(run(), ".scratch/my feature/issues/00-enhancement.md\tEnhancement\ttriage\n.scratch/my feature/issues/01-first.md\tFirst\tready\n");
  writeFileSync(join(root, ".scratch/my feature/issues/00-enhancement.md"), "# Enhancement\nStatus: needs-triage\nCategory: enhancement\nClosed: 2026-10-12\n");
  assert.equal(run(), ".scratch/my feature/issues/01-first.md\tFirst\tready\n");
  writeFileSync(join(root, ".scratch/my feature/issues/01-first.md"), "# First\nStatus: ready-for-agent\nClosed: 2026-10-12\n");
  assert.equal(run(), ".scratch/my feature/issues/02-next.md\tNext\tready\n");
});
