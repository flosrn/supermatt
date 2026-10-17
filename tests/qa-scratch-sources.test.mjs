import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../skills/qa/scripts/scratch-sources.mjs", import.meta.url);
const runtimeArgs = process.versions.bun ? ["--no-env-file"] : [];

function fixture(t, build) {
  const root = mkdtempSync(join(tmpdir(), "qa-scratch-sources-"));
  t.after(() => {
    spawnSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  const dir = join(root, "qa");
  const scratch = join(dir, "scratch");
  mkdirSync(repo);
  mkdirSync(dir);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, "-c", "user.name=QA", "-c", "user.email=qa@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  build(repo, git);
  cpSync(repo, scratch, { recursive: true, verbatimSymlinks: true, filter: (source) => source !== join(repo, ".git") });
  const run = (mode) => spawnSync(process.execPath, [...runtimeArgs, script.pathname, mode, repo, scratch, dir], { encoding: "utf8" });
  return { root, repo, dir, scratch, run };
}

const writable = (path) => (statSync(path).mode & 0o222) !== 0;
const list = (path) => readFileSync(path, "utf8").split("\0").filter(Boolean).sort();

test("prepare rejects listed links that leave the copy and changes nothing they reach", (t) => {
  const { root, repo, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "target.txt"), "real checkout\n");
    chmodSync(join(repo, "target.txt"), 0o644);
    symlinkSync(join(repo, "target.txt"), join(repo, "checkout-link"));
    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib/file.txt"), "tracked\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "file.txt"), "outside\n");
  chmodSync(join(outside, "file.txt"), 0o644);
  // An index entry under a directory the working tree replaced with an external link.
  rmSync(join(scratch, "lib"), { recursive: true });
  symlinkSync(outside, join(scratch, "lib"));

  const result = run("prepare");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /checkout-link -> .*repo\/target\.txt/);
  assert.match(result.stderr, /lib\/file\.txt \(under a link to .*outside\)/);
  for (const [path, content] of [[join(repo, "target.txt"), "real checkout\n"], [join(outside, "file.txt"), "outside\n"]]) {
    assert.equal(readFileSync(path, "utf8"), content);
    assert.equal(statSync(path).mode & 0o777, 0o644);
  }
  assert.ok(writable(join(scratch, "target.txt")), "a rejected preparation protects nothing");
});

test("prepare protects present regular files and lists deletions apart; verify reports drift", (t) => {
  const { repo, dir, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, ".gitignore"), "*.log\n");
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    writeFileSync(join(repo, "gone.txt"), "gone\n");
    symlinkSync("kept.txt", join(repo, "inside-link"));
    git("add", ".");
    git("commit", "-qm", "init");
    unlinkSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    writeFileSync(join(repo, "ignored.log"), "ignored\n");
  });

  const prepared = run("prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(list(join(dir, "sources.lst")), [".gitignore", "inside-link", "kept.txt", "untracked.txt"]);
  assert.deepEqual(list(join(dir, "deleted.lst")), ["gone.txt"]);
  assert.ok(!writable(join(scratch, "kept.txt")));
  assert.ok(!writable(join(scratch, "untracked.txt")));
  assert.ok(writable(join(scratch, "ignored.log")), "ignored files stay outside the manifest");
  assert.ok(writable(join(repo, "kept.txt")), "the real checkout is never protected");

  const clean = run("verify");
  assert.equal(clean.status, 0, clean.stdout);
  assert.equal(clean.stdout, "");

  chmodSync(join(scratch, "kept.txt"), 0o644);
  writeFileSync(join(scratch, "kept.txt"), "edited\n");
  writeFileSync(join(scratch, "gone.txt"), "back\n");
  unlinkSync(join(scratch, "inside-link"));
  const drift = run("verify");
  assert.equal(drift.status, 1);
  assert.deepEqual(drift.stdout.trim().split("\n").sort(), ["changed kept.txt (content)", "missing inside-link (copy)", "recreated gone.txt"]);
});

test("scratch sources helper requires a mode and three paths", () => {
  const result = spawnSync(process.execPath, [...runtimeArgs, script.pathname, "prepare"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
