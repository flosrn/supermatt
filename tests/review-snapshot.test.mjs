import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/code-review/scripts/snapshot-tree.mjs");
const gitEnv = { ...process.env };
const localVariables = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).trim().split("\n");
for (const key of [...localVariables, "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]) delete gitEnv[key];

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function workspace(t) {
  const base = mkdtempSync(join(tmpdir(), "review-snapshot-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  mkdirSync(root);
  git(root, "init");
  writeFileSync(join(root, "tracked.txt"), "tracked baseline\n");
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "baseline");
  return { base, root };
}

function run(root, env = process.env) {
  return spawnSync(process.execPath, [script, root], { env, encoding: "utf8" });
}

function snapshot(root, env) {
  const result = run(root, env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("detects existing untracked content mutations while unchanged and ignored files stay stable", (t) => {
  const { root } = workspace(t);
  writeFileSync(join(root, "new.txt"), "before\n");
  const before = snapshot(root);
  assert.equal(snapshot(root), before);
  writeFileSync(join(root, "ignored.txt"), "not part of review\n");
  assert.equal(snapshot(root), before);
  writeFileSync(join(root, "new.txt"), "after!\n");
  assert.notEqual(snapshot(root), before);
});

test("retains tracked working-tree and index comparisons, including binary content", (t) => {
  const { root } = workspace(t);
  const baseline = snapshot(root);
  writeFileSync(join(root, "tracked.txt"), Buffer.from([0, 1, 2, 255]));
  const working = snapshot(root);
  assert.notEqual(working, baseline);
  git(root, "add", "tracked.txt");
  const staged = snapshot(root);
  assert.notEqual(staged, working);
  assert.match(Buffer.from(JSON.parse(staged).diff, "base64").toString(), /GIT binary patch/);
});

test("detects staged-content changes without changing the working tree or porcelain state", (t) => {
  const { root } = workspace(t);
  const path = join(root, "tracked.txt");
  writeFileSync(path, "first staged value\n");
  git(root, "add", "tracked.txt");
  writeFileSync(path, "unchanged working value\n");
  const before = snapshot(root);
  writeFileSync(path, "second staged value\n");
  git(root, "add", "tracked.txt");
  writeFileSync(path, "unchanged working value\n");
  const after = snapshot(root);
  assert.equal(JSON.parse(after).status, JSON.parse(before).status);
  assert.equal(JSON.parse(after).diff, JSON.parse(before).diff);
  assert.notEqual(after, before);
});

test("captures binary contents and filenames containing whitespace, quotes, and leading dashes", (t) => {
  const { root } = workspace(t);
  const names = [Buffer.from("- odd\n\tname.bin"), Buffer.from('quote" name.bin'), Buffer.from("line\nname.bin")];
  for (const name of names) {
    writeFileSync(Buffer.concat([Buffer.from(root + "/"), name]), Buffer.from([0, 255, 1]));
  }
  const before = snapshot(root);
  const entries = JSON.parse(before).untracked;
  assert.deepEqual(new Set(entries.map(entry => entry.path)), new Set(names.map(name => name.toString("base64"))));
  writeFileSync(Buffer.concat([Buffer.from(root + "/"), names[0]]), Buffer.from([0, 254, 1]));
  assert.notEqual(snapshot(root), before);
});

test("records external and dangling symlinks without reading or executing their targets", (t) => {
  const { base, root } = workspace(t);
  const outside = join(base, "outside");
  mkdirSync(outside);
  const target = join(outside, "target.sh");
  const marker = join(outside, "executed");
  writeFileSync(target, `#!/bin/sh\nprintf unsafe > '${marker}'\n`, { mode: 0o700 });
  symlinkSync(target, join(root, "external"));
  symlinkSync(outside, join(root, "directory-link"));
  symlinkSync(join(outside, "missing"), join(root, "dangling"));
  const before = snapshot(root);
  writeFileSync(target, "changed outside the repository\n");
  writeFileSync(join(outside, "new-child"), "outside child\n");
  assert.equal(snapshot(root), before);
  assert.throws(() => readFileSync(marker), { code: "ENOENT" });
  const entries = JSON.parse(before).untracked;
  assert.equal(entries.length, 3);
  assert.equal(entries.every(entry => entry.type === "symlink" && !entry.sha256), true);
  unlinkSync(join(root, "external"));
  symlinkSync(join(outside, "other"), join(root, "external"));
  assert.notEqual(snapshot(root), before);
});

test("snapshot uses the requested repository instead of inherited Git locations", (t) => {
  const { root } = workspace(t);
  const { root: other } = workspace(t);
  writeFileSync(join(other, "tracked.txt"), "other repository\n");
  git(other, "add", "tracked.txt");
  git(other, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "other history");
  const expected = snapshot(root);
  assert.equal(snapshot(root, {
    ...process.env,
    GIT_DIR: join(other, ".git"),
    GIT_COMMON_DIR: join(other, ".git"),
    GIT_WORK_TREE: root,
    GIT_INDEX_FILE: join(other, ".git/index"),
    GIT_OBJECT_DIRECTORY: join(other, ".git/objects"),
  }), expected);
});

test("nested staged changes remain visible with an inherited alternate index", (t) => {
  const { base, root } = workspace(t);
  const nested = join(root, "nested");
  mkdirSync(nested);
  git(nested, "init");
  const path = join(nested, "tracked.txt");
  writeFileSync(path, "tracked baseline\n");
  git(nested, "add", ".");
  git(nested, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "nested baseline");
  const index = join(base, "stale-index");
  writeFileSync(index, readFileSync(join(nested, ".git/index")));
  const env = { ...process.env, GIT_INDEX_FILE: index };
  writeFileSync(path, "unchanged working value\n");
  const before = JSON.parse(snapshot(root, env));
  writeFileSync(path, "new staged value\n");
  git(nested, "add", "tracked.txt");
  writeFileSync(path, "unchanged working value\n");
  const after = JSON.parse(snapshot(root, env));
  assert.equal(after.untracked[0].diff, before.untracked[0].diff);
  assert.notEqual(after.untracked[0].staged, before.untracked[0].staged);
});

test("captures nested repository HEAD, dirty content, index, and untracked changes", (t) => {
  const { root } = workspace(t);
  const nested = join(root, "nested");
  mkdirSync(nested);
  git(nested, "init");
  const newborn = snapshot(root);
  assert.equal(snapshot(root), newborn);
  writeFileSync(join(nested, "tracked.txt"), "baseline\n");
  const unstaged = snapshot(root);
  assert.notEqual(unstaged, newborn);
  git(nested, "add", ".");
  const initialIndex = snapshot(root);
  assert.notEqual(initialIndex, unstaged);
  assert.equal(JSON.parse(initialIndex).untracked[0].head, null);
  git(nested, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "nested baseline");
  const clean = snapshot(root);
  assert.notEqual(clean, newborn);
  assert.equal(snapshot(root), clean);
  git(nested, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "new HEAD");
  assert.notEqual(snapshot(root), clean);
  writeFileSync(join(nested, "tracked.txt"), "first dirty value\n");
  const dirty = snapshot(root);
  writeFileSync(join(nested, "tracked.txt"), "second dirty value\n");
  const dirtier = snapshot(root);
  assert.equal(JSON.parse(dirtier).status, JSON.parse(dirty).status);
  assert.equal(JSON.parse(dirtier).untracked[0].status, JSON.parse(dirty).untracked[0].status);
  assert.notEqual(dirtier, dirty);
  git(nested, "add", ".");
  writeFileSync(join(nested, "tracked.txt"), "unchanged working value\n");
  const staged = snapshot(root);
  writeFileSync(join(nested, "tracked.txt"), "another staged value\n");
  git(nested, "add", ".");
  writeFileSync(join(nested, "tracked.txt"), "unchanged working value\n");
  const restaged = snapshot(root);
  assert.equal(JSON.parse(restaged).untracked[0].diff, JSON.parse(staged).untracked[0].diff);
  assert.equal(JSON.parse(restaged).untracked[0].status, JSON.parse(staged).untracked[0].status);
  assert.notEqual(restaged, staged);
  writeFileSync(join(nested, "new.txt"), "first untracked value\n");
  const untracked = snapshot(root);
  writeFileSync(join(nested, "new.txt"), "second untracked value\n");
  assert.notEqual(snapshot(root), untracked);
});

test("nested repositories retain byte-safe paths and do not read symlink targets or run Git helpers", (t) => {
  const { base, root } = workspace(t);
  const nested = Buffer.concat([Buffer.from(root + "/"), Buffer.from("nested ü\n\"")]);
  mkdirSync(nested);
  git(nested, "init");
  writeFileSync(Buffer.concat([nested, Buffer.from("/tracked.txt")]), "baseline\n");
  git(nested, "add", ".");
  git(nested, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "nested baseline");
  const marker = join(base, "executed");
  const helper = join(base, "helper.sh");
  writeFileSync(helper, `#!/bin/sh\nprintf unsafe > '${marker}'\n`, { mode: 0o700 });
  git(nested, "config", "core.fsmonitor", helper);
  git(nested, "config", "diff.external", helper);
  const target = join(base, "outside");
  writeFileSync(target, "outside content\n");
  symlinkSync(target, Buffer.concat([nested, Buffer.from("/external")]));
  writeFileSync(Buffer.concat([nested, Buffer.from("/tracked.txt")]), "dirty\n");
  const before = snapshot(root);
  writeFileSync(target, "changed outside content\n");
  assert.equal(snapshot(root), before);
  assert.throws(() => readFileSync(marker), { code: "ENOENT" });
  assert.equal(JSON.parse(before).untracked[0].path, Buffer.from("nested ü\n\"").toString("base64"));
});

test("nested repository metadata links and pointer files fail closed", (t) => {
  const { base, root } = workspace(t);
  const outside = join(base, "outside");
  mkdirSync(outside);
  git(outside, "init");
  const nested = join(root, "nested");
  mkdirSync(nested);
  symlinkSync(join(outside, ".git"), join(nested, ".git"));
  const linked = run(root);
  assert.notEqual(linked.status, 0);
  assert.equal(linked.stdout, "");
  assert.match(linked.stderr, /Unsupported nested repository metadata/);
  unlinkSync(join(nested, ".git"));
  writeFileSync(join(nested, ".git"), `gitdir: ${join(outside, ".git")}\n`);
  const pointer = run(root);
  assert.notEqual(pointer.status, 0);
  assert.equal(pointer.stdout, "");
  assert.match(pointer.stderr, /Unsupported nested repository metadata/);
});

test("Git failures produce no successful snapshot", (t) => {
  const { base } = workspace(t);
  const invalid = run(base);
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Working-tree snapshot failed/);
  const empty = join(base, "empty");
  mkdirSync(empty);
  git(empty, "init");
  const missingHead = run(empty);
  assert.notEqual(missingHead.status, 0);
  assert.equal(missingHead.stdout, "");
  assert.match(missingHead.stderr, /Working-tree snapshot failed/);
});
