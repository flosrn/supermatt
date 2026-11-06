import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// tdd's "Mutate before you finish" recipe for a test that reads committed Git state, run as written there.
const references = fileURLToPath(new URL("../references", import.meta.url));
const recipe = `unset $(git rev-parse --local-env-vars)
node "$REFERENCES/copy-scratch-tree.mjs" "$REPO" "$SCRATCH"
node "$REFERENCES/check-scratch-containment.mjs" "$SCRATCH"
cd "$SCRATCH"
git init -q
test "$(git rev-parse --absolute-git-dir)" = "$(pwd -P)/.git"
git add -A
git commit -qm baseline
printf 'mutant\\n' > value.txt
git commit -q --allow-empty -am mutant
`;

const baseEnv = { ...process.env };
const localVariables = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).trim().split("\n");
for (const key of [...localVariables, "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]) delete baseEnv[key];

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "tdd scratch commit "));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const config = join(base, "gitconfig");
  writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  const env = { ...baseEnv, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  const main = join(base, "main");
  const worktree = join(base, "worktree");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git(base, "init", "-q", main);
  writeFileSync(join(main, "value.txt"), "original\n");
  git(main, "add", "value.txt");
  git(main, "commit", "-qm", "base");
  git(main, "worktree", "add", "-q", "-b", "fix-x", worktree);
  writeFileSync(join(worktree, "value.txt"), "work in progress\n");
  git(worktree, "commit", "-qam", "work");
  // The copy sits inside the main checkout, an enclosing repository that a missed git init would commit into.
  const scratch = join(main, "scratch");
  const refs = () => git(main, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
  return { env, main, worktree, scratch, git, refs };
}

function follow({ env, worktree, scratch }, extraEnv = {}) {
  return spawnSync("sh", ["-eu", "-c", recipe], {
    env: { ...env, ...extraEnv, REFERENCES: references, REPO: worktree, SCRATCH: scratch },
    encoding: "utf8",
  });
}

function assertContained(setup, before, result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(setup.refs(), before);
  assert.equal(setup.git(setup.worktree, "status", "--porcelain"), "");
  assert.equal(setup.git(setup.scratch, "log", "--format=%s"), "mutant\nbaseline");
}

test("the tdd scratch commit recipe commits mutants in the copy of a linked worktree, not on its branch", (t) => {
  const setup = fixture(t);
  const before = setup.refs();
  assertContained(setup, before, follow(setup));
});

test("the tdd scratch commit recipe keeps an inherited GIT_DIR from committing on the source branch", (t) => {
  const setup = fixture(t);
  const before = setup.refs();
  const gitdir = setup.git(setup.worktree, "rev-parse", "--absolute-git-dir");
  assertContained(setup, before, follow(setup, { GIT_DIR: gitdir, GIT_INDEX_FILE: join(gitdir, "index") }));
});
