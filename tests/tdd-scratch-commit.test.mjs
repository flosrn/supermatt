import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const references = fileURLToPath(new URL("../references", import.meta.url));
const skill = readFileSync(new URL("../skills/tdd/SKILL.md", import.meta.url), "utf8");
const recipe = skill.match(/  ```sh\n([\s\S]*?)  ```/)[1]
  .replace(/^  /gm, "")
  .replaceAll("<references>", references)
  .replaceAll("<repo>", "$REPO")
  .replaceAll("<scratch>", "$SCRATCH");
const mutationRecipe = skill.match(/  ```sh\n([\s\S]*?)  ```/g)[1].replace(/^  ```sh\n|  ```$/g, "")
  .replace(/^  /gm, "")
  .replaceAll("<skill>", fileURLToPath(new URL("../skills/tdd", import.meta.url)))
  .replaceAll("<mutation files>", '"$MUTATION_A" "$MUTATION_B"');

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
  return { base, env, main, worktree, scratch, git, refs };
}

function follow({ env, worktree, scratch }, extraEnv = {}) {
  return spawnSync("sh", ["-eu", "-c", recipe + "\nprintf 'mutant\\n' > value.txt\ngit commit -q --allow-empty -am mutant\n"], {
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

test("the tdd scratch commit recipe ignores templates that redirect the common Git directory", (t) => {
  const setup = fixture(t);
  const template = join(setup.base, "template");
  mkdirSync(template);
  writeFileSync(join(template, "commondir"), `${join(setup.main, ".git")}\n`);
  const before = setup.refs();
  const result = follow(setup, { GIT_TEMPLATE_DIR: template });
  assert.equal(setup.refs(), before, "the template must not move any source branch");
  assertContained(setup, before, result);
  assert.equal(setup.git(setup.scratch, "rev-parse", "--path-format=absolute", "--git-common-dir"), realpathSync(join(setup.scratch, ".git")));
});

test("the tdd scratch baseline preserves force-tracked ignored files and source deletions", (t) => {
  const setup = fixture(t);
  const artifact = "release '雪\n.json";
  writeFileSync(join(setup.worktree, ".gitignore"), "*.json\n");
  writeFileSync(join(setup.worktree, artifact), "original artifact\n");
  writeFileSync(join(setup.worktree, "deleted.txt"), "removed\n");
  setup.git(setup.worktree, "add", "-f", "--", ".gitignore", artifact, "deleted.txt");
  setup.git(setup.worktree, "commit", "-qm", "tracked artifacts");
  rmSync(join(setup.worktree, "deleted.txt"));
  const before = setup.refs();
  const status = setup.git(setup.worktree, "status", "--porcelain");
  assert.equal(follow(setup).status, 0);
  assert.equal(setup.refs(), before);
  assert.equal(setup.git(setup.worktree, "status", "--porcelain"), status);
  const committed = spawnSync("git", ["show", `HEAD:${artifact}`], { cwd: setup.scratch, env: setup.env, encoding: "utf8" });
  assert.equal(committed.status, 0, "force-tracked ignored artifact must exist in the baseline");
  assert.equal(committed.stdout, "original artifact\n");
  assert.equal(setup.git(setup.scratch, "ls-files", "--", "deleted.txt"), "");
  writeFileSync(join(setup.scratch, artifact), "mutated artifact\n");
  setup.git(setup.scratch, "commit", "-qam", "artifact mutant");
  assert.equal(setup.git(setup.scratch, "show", `HEAD:${artifact}`), "mutated artifact");
});

test("committed mutations start from the baseline and leave HEAD and index restored", (t) => {
  const setup = fixture(t);
  assert.equal(follow(setup).status, 0);
  writeFileSync(join(setup.scratch, "other.txt"), "original\n");
  setup.git(setup.scratch, "add", "other.txt");
  setup.git(setup.scratch, "commit", "-qm", "second target");
  const before = setup.git(setup.scratch, "rev-parse", "HEAD");
  const a = join(setup.base, "a.mutation");
  const b = join(setup.base, "b.mutation");
  writeFileSync(a, "value.txt\nmutant\n====\nbroken\n");
  writeFileSync(b, "other.txt\noriginal\n====\nbroken\n");
  const check = "test $(git diff-tree --no-commit-id --name-only -r HEAD | wc -l) -le 1 && test $(git show HEAD:value.txt) != broken";
  const result = spawnSync("sh", ["-eu", "-c", mutationRecipe.replaceAll("<test command>", check)], {
    cwd: setup.scratch,
    env: { ...setup.env, MUTATION_A: a, MUTATION_B: b },
    encoding: "utf8",
  });
  assert.match(result.stdout, /a\.mutation test-failed/);
  assert.match(result.stdout, /b\.mutation GREEN/, result.stderr);
  assert.equal(result.status, 1);
  assert.equal(setup.git(setup.scratch, "rev-parse", "HEAD"), before);
  assert.equal(setup.git(setup.scratch, "diff", "--cached"), "");
  assert.equal(setup.git(setup.scratch, "status", "--porcelain"), "");
});

test("an interrupted committing TEST restores the scratch HEAD, index, and target bytes", (t) => {
  const setup = fixture(t);
  const sourceBefore = setup.refs();
  assert.equal(follow(setup).status, 0);
  const before = setup.git(setup.scratch, "rev-parse", "HEAD");
  const mutation = join(setup.base, "interrupt.mutation");
  writeFileSync(mutation, "value.txt\nmutant\n====\nbroken\n");
  const command = 'if test "$(git show HEAD:value.txt)" = broken; then trap "echo SIGNAL_DELIVERED >&2; exit 130" TERM; kill -TERM $$; fi';
  const result = spawnSync("sh", ["-eu", "-c", mutationRecipe.replaceAll("<test command>", () => command)], {
    cwd: setup.scratch,
    env: { ...setup.env, MUTATION_A: mutation, MUTATION_B: mutation },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /interrupt\.mutation test-failed/);
  assert.match(result.stderr, /SIGNAL_DELIVERED/);
  assert.doesNotMatch(result.stderr, /Illegal number/);
  assert.equal(setup.git(setup.scratch, "rev-parse", "HEAD"), before);
  assert.equal(setup.git(setup.scratch, "status", "--porcelain"), "");
  assert.equal(setup.refs(), sourceBefore);
});

test("the scratch baseline treats a tracked file replaced by a directory as a deletion", (t) => {
  const setup = fixture(t);
  rmSync(join(setup.worktree, "value.txt"));
  mkdirSync(join(setup.worktree, "value.txt"));
  writeFileSync(join(setup.worktree, "value.txt", "nested"), "replacement content\n");
  const before = setup.refs();
  const status = setup.git(setup.worktree, "status", "--porcelain");
  const result = spawnSync("sh", ["-eu", "-c", recipe], {
    env: { ...setup.env, REPO: setup.worktree, SCRATCH: setup.scratch },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(setup.git(setup.scratch, "show", "HEAD:value.txt/nested"), "replacement content");
  assert.equal(setup.refs(), before);
  assert.equal(setup.git(setup.worktree, "status", "--porcelain"), status);
});

test("scratch tracking preserves non-UTF-8 names without tracking their replacement-character aliases", (t) => {
  const setup = fixture(t);
  const name = Buffer.concat([Buffer.from("raw-"), Buffer.from([255]), Buffer.from(".json")]);
  const source = Buffer.concat([Buffer.from(`${setup.worktree}/`), name]);
  writeFileSync(join(setup.worktree, ".gitignore"), "*.json\n");
  try {
    writeFileSync(source, "tracked bytes\n");
  } catch (error) {
    if (error.code !== "EILSEQ") throw error;
    // APFS rejects invalid UTF-8 names; keep exercising raw-byte tracking on filesystems that support them.
    t.skip("the fixture filesystem rejects non-UTF-8 filenames (EILSEQ)");
    return;
  }
  writeFileSync(join(setup.worktree, "raw-�.json"), "untracked alias\n");
  execFileSync("git", ["update-index", "--add", "-z", "--stdin"], {
    cwd: setup.worktree, env: setup.env, input: Buffer.concat([name, Buffer.from([0])]),
  });
  const before = setup.refs();
  assert.equal(follow(setup).status, 0);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: setup.scratch, env: setup.env });
  assert.notEqual(tracked.indexOf(Buffer.concat([name, Buffer.from([0])])), -1, "raw-byte tracked name must survive");
  assert.equal(tracked.indexOf(Buffer.from("raw-�.json\0")), -1, "ignored untracked alias must remain untracked");
  assert.equal(setup.refs(), before);
});
