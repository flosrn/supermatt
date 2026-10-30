import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const script = fileURLToPath(new URL("../references/copy-scratch-tree.mjs", import.meta.url));
const runtimeArgs = process.versions.bun ? ["--no-env-file"] : [];
const run = (source, target, env = process.env) => spawnSync(process.execPath, [...runtimeArgs, script, source, target], { encoding: "utf8", env });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "scratch copy "));
  t.after(() => {
    spawnSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, "source");
  const target = join(root, "scratch");
  mkdirSync(source);
  return { root, source, target };
}

test("scratch copying omits Git directories at every depth and keeps untracked and ignored files", (t) => {
  const { source, target } = fixture(t);
  mkdirSync(join(source, ".git/objects"), { recursive: true });
  writeFileSync(join(source, ".git/objects/private"), "metadata");
  mkdirSync(join(source, "nested/.git"), { recursive: true });
  writeFileSync(join(source, "nested/.git/config"), "metadata");
  writeFileSync(join(source, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(source, "ignored.txt"), "ignored\n");
  writeFileSync(join(source, "untracked.txt"), "untracked\n");

  const result = run(source, target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(target, ".git")), false);
  assert.equal(existsSync(join(target, "nested/.git")), false);
  assert.equal(readFileSync(join(target, "ignored.txt"), "utf8"), "ignored\n");
  assert.equal(readFileSync(join(target, "untracked.txt"), "utf8"), "untracked\n");
  assert.equal(readFileSync(join(source, ".git/objects/private"), "utf8"), "metadata");
});

test("scratch copying omits worktree Git files and preserves symlinks, modes, and source isolation", (t) => {
  const { root, source, target } = fixture(t);
  writeFileSync(join(source, ".git"), "gitdir: /elsewhere/worktrees/topic\n");
  mkdirSync(join(source, "data"));
  writeFileSync(join(source, "data/value"), "original\n");
  writeFileSync(join(source, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o751 });
  chmodSync(join(source, "run.sh"), 0o751);
  symlinkSync("data/value", join(source, "value"));
  symlinkSync("..", join(source, "data/parent"));
  symlinkSync("missing", join(source, "broken"));
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "untouched"), "outside\n");
  symlinkSync(outside, join(source, "external"));

  const result = run(source, target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(target, ".git")), false);
  for (const [name, link] of [["value", "data/value"], ["data/parent", ".."], ["broken", "missing"], ["external", outside]]) {
    assert.ok(lstatSync(join(target, name)).isSymbolicLink());
    assert.equal(readlinkSync(join(target, name)), link);
  }
  assert.equal(statSync(join(target, "run.sh")).mode & 0o777, 0o751);
  writeFileSync(join(target, "value"), "changed\n");
  assert.equal(readFileSync(join(source, "data/value"), "utf8"), "original\n");
  assert.equal(readFileSync(join(outside, "untouched"), "utf8"), "outside\n");
  assert.equal(readFileSync(join(source, ".git"), "utf8"), "gitdir: /elsewhere/worktrees/topic\n");
});

test("failed cloning discards its partial tree before the rsync fallback", (t) => {
  const { root, source, target } = fixture(t);
  mkdirSync(join(source, "nested"));
  writeFileSync(join(source, "nested/file"), "source\n");
  writeFileSync(join(source, ".git"), "gitdir: /metadata\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, process.platform === "darwin" ? "python3" : "cp"), "#!/bin/sh\nfor target do :; done\nmkdir -p \"$target\"\nprintf partial > \"$target/partial-only\"\nexit 1\n", { mode: 0o755 });
  const result = run(source, target, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rsync/);
  assert.equal(existsSync(join(target, "partial-only")), false);
  assert.equal(existsSync(join(target, ".git")), false);
  assert.equal(readFileSync(join(target, "nested/file"), "utf8"), "source\n");
});

function tree(directory) {
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    return [name, stat.mode & 0o7777, stat.isSymbolicLink() ? ["link", readlinkSync(path)] : stat.isDirectory() ? tree(path) : ["file", readFileSync(path).toString("hex")]];
  });
}

test("cloning and unavailable cloning yield the same tree as rsync, without FIFOs or Git links", (t) => {
  const { root, source, target } = fixture(t);
  writeFileSync(join(source, "file"), "unchanged\n", { mode: 0o640 });
  mkdirSync(join(source, "nested"));
  symlinkSync("../file", join(source, "nested/link"));
  symlinkSync("..", join(source, "nested/cycle"));
  const metadata = join(root, "metadata");
  mkdirSync(metadata);
  writeFileSync(join(metadata, "keep"), "metadata\n");
  symlinkSync(metadata, join(source, "nested/.git"));
  assert.equal(spawnSync("mkfifo", [join(source, "pipe")]).status, 0);
  chmodSync(join(source, "nested"), 0o555);
  const expected = join(root, "rsync");
  const baseline = spawnSync("rsync", ["-a", "--no-specials", "--no-devices", "--exclude", ".git", "--", `${source}/`, `${expected}/`], { encoding: "utf8" });
  assert.equal(baseline.status, 0, baseline.stderr);
  const cloned = run(source, target);
  assert.equal(cloned.status, 0, cloned.stderr);
  assert.deepEqual(tree(target), tree(expected));

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, process.platform === "darwin" ? "python3" : "cp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const fallback = join(root, "fallback");
  const copied = run(source, fallback, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(copied.status, 0, copied.stderr);
  assert.match(copied.stdout, /rsync/);
  assert.deepEqual(tree(fallback), tree(expected));
  writeFileSync(join(fallback, "file"), "changed\n");
  assert.equal(readFileSync(join(source, "file"), "utf8"), "unchanged\n");
  assert.equal(readFileSync(join(metadata, "keep"), "utf8"), "metadata\n");
});

test("a socket does not survive the copy or prevent ordinary files from being copied", async (t) => {
  const { source, target } = fixture(t);
  writeFileSync(join(source, "file"), "ordinary\n");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(source, "socket"), resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = run(source, target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(target, "socket")), false);
  assert.equal(readFileSync(join(target, "file"), "utf8"), "ordinary\n");
});

test("copying refuses an existing destination or a destination inside the source without changing either", (t) => {
  const { source, target } = fixture(t);
  writeFileSync(join(source, "file"), "original\n");
  mkdirSync(target);
  writeFileSync(join(target, "keep"), "existing\n");
  const existing = run(source, target);
  assert.equal(existing.status, 1);
  assert.equal(readFileSync(join(target, "keep"), "utf8"), "existing\n");
  const nested = run(source, join(source, "scratch"));
  assert.equal(nested.status, 1);
  assert.equal(existsSync(join(source, "scratch")), false);
  assert.equal(readFileSync(join(source, "file"), "utf8"), "original\n");
});

test("a clone preserves set-user-ID and set-group-ID file modes", (t) => {
  const { source, target } = fixture(t);
  writeFileSync(join(source, "privileged"), "ordinary scratch fixture\n");
  chmodSync(join(source, "privileged"), 0o6751);
  const result = run(source, target);
  assert.equal(result.status, 0, result.stderr);
  if (process.platform === "darwin") assert.match(result.stdout, /clonefile/);
  assert.equal(statSync(join(target, "privileged")).mode & 0o7777, 0o6751);
});

test("source hardlinks become independent scratch files like rsync without -H", (t) => {
  const { source, target } = fixture(t);
  writeFileSync(join(source, "first"), "original\n");
  linkSync(join(source, "first"), join(source, "second"));
  const result = run(source, target);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(target, "first"), "changed\n");
  assert.equal(readFileSync(join(target, "second"), "utf8"), "original\n");
  assert.equal(readFileSync(join(source, "first"), "utf8"), "original\n");
});

test("a clone preserves special directory modes at the root and below it", (t) => {
  const { source, target } = fixture(t);
  mkdirSync(join(source, "nested"));
  chmodSync(source, 0o2755);
  chmodSync(join(source, "nested"), 0o2750);
  const result = run(source, target);
  assert.equal(result.status, 0, result.stderr);
  if (process.platform === "darwin") assert.match(result.stdout, /clonefile/);
  assert.equal(statSync(target).mode & 0o7777, 0o2755);
  assert.equal(statSync(join(target, "nested")).mode & 0o7777, 0o2750);
});
