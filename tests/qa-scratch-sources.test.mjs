import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A hook in a linked worktree exports an absolute GIT_DIR, which would aim every git command below at the real repo.
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete process.env[name];

const script = fileURLToPath(new URL("../skills/qa/scripts/scratch-sources.mjs", import.meta.url));
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
  const run = (mode) => spawnSync(process.execPath, [...runtimeArgs, script, mode, repo, scratch, dir], { encoding: "utf8" });
  return { root, repo, dir, scratch, run };
}

const writable = (path) => (statSync(path).mode & 0o222) !== 0;
const list = (path) => readFileSync(path, "utf8").split("\0").filter(Boolean).sort();

// A file outside the copy, created after the copy so only a followed link reaches it.
function outsideFile(root) {
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "file.txt"), "outside\n");
  chmodSync(join(outside, "file.txt"), 0o644);
  return join(outside, "file.txt");
}
function assertUntouched(path) {
  assert.equal(readFileSync(path, "utf8"), "outside\n");
  assert.equal(statSync(path).mode & 0o777, 0o644);
}

test("prepare rejects listed links that leave the copy and changes nothing they reach", (t) => {
  const { root, repo, dir, scratch, run } = fixture(t, (repo, git) => {
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
  assert.ok(!existsSync(join(dir, "sources.lst")), "a rejected preparation leaves no manifest for verify to pass on");
  assert.ok(!existsSync(join(dir, "deleted.lst")));
});

// A prepared copy holding two files with equal bytes and a link to one of them.
function prepared(t) {
  const context = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    writeFileSync(join(repo, "twin.txt"), "kept\n");
    symlinkSync("kept.txt", join(repo, "inside-link"));
    git("add", ".");
    git("commit", "-qm", "init");
  });
  const result = context.run("prepare");
  assert.equal(result.status, 0, result.stderr);
  return context;
}
const drift = (result) => {
  assert.equal(result.status, 1, result.stderr);
  return result.stdout.trim().split("\n").sort();
};

test("verify reports a source file the copy replaced with a directory", (t) => {
  const { scratch, run } = prepared(t);
  rmSync(join(scratch, "kept.txt"));
  mkdirSync(join(scratch, "kept.txt"));
  assert.deepEqual(drift(run("verify")), ["changed kept.txt (file became directory)"]);
});

test("verify reports a source file the copy replaced with a link to equal bytes", (t) => {
  const { scratch, run } = prepared(t);
  rmSync(join(scratch, "kept.txt"));
  symlinkSync("twin.txt", join(scratch, "kept.txt"));
  assert.deepEqual(drift(run("verify")), ["changed kept.txt (file became link)"]);
});

test("verify reports a source link the copy pointed elsewhere", (t) => {
  const { scratch, run } = prepared(t);
  unlinkSync(join(scratch, "inside-link"));
  symlinkSync("twin.txt", join(scratch, "inside-link"));
  assert.deepEqual(drift(run("verify")), ["changed inside-link (link target)"]);
});

test("verify detects lost executable bits while accepting source write protection", (t) => {
  const { scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(join(repo, "run.sh"), 0o755);
    git("add", ".");
    git("commit", "-qm", "init");
  });
  assert.equal(run("prepare").status, 0);
  assert.equal(statSync(join(scratch, "run.sh")).mode & 0o777, 0o555);
  assert.equal(run("verify").status, 0);

  chmodSync(join(scratch, "run.sh"), 0o444);
  assert.deepEqual(drift(run("verify")), ["changed run.sh (executable bits)"]);
});

test("verify reports a source that disappeared from the repository, not from the copy", (t) => {
  const { repo, run } = prepared(t);
  unlinkSync(join(repo, "twin.txt"));
  assert.deepEqual(drift(run("verify")), ["missing twin.txt (repository)"]);
});

test("a source named with a space and a newline is listed, protected, and checked", (t) => {
  const name = "odd name\nsecond line.txt";
  const { dir, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, name), "odd\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });

  const prepared = run("prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(list(join(dir, "sources.lst")), [name]);
  assert.ok(!writable(join(scratch, name)));
  assert.equal(run("verify").status, 0);

  chmodSync(join(scratch, name), 0o644);
  writeFileSync(join(scratch, name), "edited\n");
  const result = run("verify");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `changed ${name} (content)\n`);
});

test("prepare rejects a relative link that climbs out of the copy", (t) => {
  const { root, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    symlinkSync("../../outside/file.txt", join(repo, "climbing-link"));
    git("add", ".");
    git("commit", "-qm", "init");
  });
  const outside = outsideFile(root);

  const result = run("prepare");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /climbing-link -> .*outside\/file\.txt/);
  assertUntouched(outside);
  assert.ok(writable(join(scratch, "kept.txt")), "a rejected preparation protects nothing");
});

test("prepare follows a link chain to its last hop and rejects it when that hop leaves the copy", (t) => {
  const { root, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, ".gitignore"), "second-hop\n");
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    symlinkSync("second-hop", join(repo, "first-hop"));
    git("add", ".");
    git("commit", "-qm", "init");
  });
  const outside = outsideFile(root);
  // The second hop is ignored, so only the first hop is listed.
  symlinkSync(outside, join(scratch, "second-hop"));

  const result = run("prepare");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /first-hop -> .*outside\/file\.txt/);
  assertUntouched(outside);
  assert.ok(writable(join(scratch, "kept.txt")), "a rejected preparation protects nothing");
});

test("prepare rejects a link chain with a dangling final target outside the copy", (t) => {
  const { root, dir, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, ".gitignore"), "second-hop\n");
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    symlinkSync("second-hop", join(repo, "first-hop"));
    git("add", ".");
    git("commit", "-qm", "init");
  });
  symlinkSync(join(root, "missing.txt"), join(scratch, "second-hop"));

  const result = run("prepare");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /first-hop -> .*missing\.txt/);
  assert.ok(writable(join(scratch, "kept.txt")), "a rejected preparation protects nothing");
  assert.ok(!existsSync(join(dir, "sources.lst")));
  assert.ok(!existsSync(join(dir, "deleted.lst")));
});

test("prepare lists a dangling link that stays inside the copy as a source", (t) => {
  const { dir, run } = fixture(t, (repo, git) => {
    symlinkSync("not-yet-built.txt", join(repo, "dangling-link"));
    git("add", ".");
    git("commit", "-qm", "init");
  });

  const result = run("prepare");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(list(join(dir, "sources.lst")), ["dangling-link"]);
  assert.deepEqual(list(join(dir, "deleted.lst")), []);
});

test("prepare rejects a dangling link that points outside the copy", (t) => {
  const { scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    symlinkSync(join(repo, "../not-yet-created/file.txt"), join(repo, "dangling-out"));
    git("add", ".");
    git("commit", "-qm", "init");
  });

  const result = run("prepare");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /dangling-out -> .*not-yet-created\/file\.txt/);
  assert.ok(writable(join(scratch, "kept.txt")), "a rejected preparation protects nothing");
});

test("prepare writes no manifest when the repository cannot be listed", (t) => {
  const { root, dir, scratch } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });
  const notRepo = join(root, "not-a-repo");
  mkdirSync(notRepo);

  const result = spawnSync(process.execPath, [...runtimeArgs, script, "prepare", notRepo, scratch, dir], { encoding: "utf8" });
  assert.notEqual(result.status, 0, result.stdout);
  // Empty manifests would let a later verify pass with nothing checked.
  assert.ok(!existsSync(join(dir, "sources.lst")));
  assert.ok(!existsSync(join(dir, "deleted.lst")));
  assert.ok(writable(join(scratch, "kept.txt")));
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
  const result = spawnSync(process.execPath, [...runtimeArgs, script, "prepare"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test("verify without a manifest directory is a usage error, not a difference", (t) => {
  const { repo, scratch } = fixture(t, () => {});
  const result = spawnSync(process.execPath, [...runtimeArgs, script, "verify", repo, scratch], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test("verify before prepare is a setup error, not a difference", (t) => {
  const { run } = fixture(t, () => {});
  const result = run("verify");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /sources\.lst/);
});

test("verify with an unreadable manifest is a setup error, not a difference", (t) => {
  const { dir, run } = fixture(t, () => {});
  mkdirSync(join(dir, "sources.lst"));
  const result = run("verify");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /sources\.lst/);
});

test("verify reports each entry it cannot read as a difference", { skip: process.getuid?.() === 0 && "root reads unreadable entries" }, (t) => {
  const { scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    mkdirSync(join(repo, "locked"));
    writeFileSync(join(repo, "locked/keep.txt"), "keep\n");
    writeFileSync(join(repo, "locked/gone.txt"), "gone\n");
    git("add", ".");
    git("commit", "-qm", "init");
    unlinkSync(join(repo, "locked/gone.txt"));
  });
  assert.equal(run("prepare").status, 0);

  // The reader locked one copied file and one copied directory.
  chmodSync(join(scratch, "a.txt"), 0o000);
  chmodSync(join(scratch, "locked"), 0o000);
  let result;
  try {
    result = run("verify");
  } finally {
    chmodSync(join(scratch, "locked"), 0o755);
    chmodSync(join(scratch, "a.txt"), 0o644);
  }
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").sort(), ["unreadable a.txt (EACCES)", "unreadable locked/gone.txt (EACCES)", "unreadable locked/keep.txt (EACCES)"]);
});

test("prepare protects the in-copy file a source reaches through a linked directory inside the copy", (t) => {
  const { repo, dir, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib/file.txt"), "tracked\n");
    git("add", ".");
    git("commit", "-qm", "init");
    // The working tree moved lib under an ignored directory and left a link in its place.
    rmSync(join(repo, "lib"), { recursive: true });
    mkdirSync(join(repo, "build/lib"), { recursive: true });
    writeFileSync(join(repo, "build/lib/file.txt"), "tracked\n");
    symlinkSync("build/lib", join(repo, "lib"));
  });

  const result = run("prepare");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(list(join(dir, "sources.lst")).includes("lib/file.txt"));
  assert.ok(!writable(join(scratch, "build/lib/file.txt")), "the file behind the in-copy link is protected");
  assert.ok(writable(join(repo, "build/lib/file.txt")), "the real checkout is never protected");
});

test("scratch sources helper rejects an unknown mode", (t) => {
  const { repo, dir, scratch } = fixture(t, () => {});
  const result = spawnSync(process.execPath, [...runtimeArgs, script, "check", repo, scratch, dir], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test("prepare lists a tracked file whose directory the working tree replaced with a file as deleted", (t) => {
  const { dir, run } = fixture(t, (repo, git) => {
    mkdirSync(join(repo, "a"));
    writeFileSync(join(repo, "a/b.txt"), "tracked\n");
    git("add", ".");
    git("commit", "-qm", "init");
    rmSync(join(repo, "a"), { recursive: true });
    writeFileSync(join(repo, "a"), "now a file\n");
  });

  const result = run("prepare");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(list(join(dir, "sources.lst")), ["a"]);
  assert.deepEqual(list(join(dir, "deleted.lst")), ["a/b.txt"]);
});

test("prepare rejects a link into a sibling whose name extends the copy's name", (t) => {
  const { dir, scratch, run } = fixture(t, (repo, git) => {
    symlinkSync("../scratch-sibling/file.txt", join(repo, "sibling-link"));
    git("add", ".");
    git("commit", "-qm", "init");
  });
  const sibling = join(dir, "scratch-sibling");
  mkdirSync(sibling);
  writeFileSync(join(sibling, "file.txt"), "outside\n");
  chmodSync(join(sibling, "file.txt"), 0o644);
  assert.ok(sibling.startsWith(scratch));

  const result = run("prepare");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /sibling-link -> .*scratch-sibling\/file\.txt/);
  assertUntouched(join(sibling, "file.txt"));
});

test("prepare lists a path with a merge conflict once", (t) => {
  const { dir, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "f.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "other");
    writeFileSync(join(repo, "f.txt"), "other\n");
    git("commit", "-qam", "other");
    git("checkout", "-q", "-");
    writeFileSync(join(repo, "f.txt"), "main\n");
    git("commit", "-qam", "main");
    // The merge stops on the conflict and leaves three index stages for f.txt.
    spawnSync("git", ["-C", repo, "-c", "user.name=QA", "-c", "user.email=qa@example.com", "merge", "-q", "other"], { encoding: "utf8" });
  });

  const result = run("prepare");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(list(join(dir, "sources.lst")), ["f.txt"]);
});

test("prepare lists an embedded repository's directory but leaves it writable", (t) => {
  const { dir, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    git("add", ".");
    git("commit", "-qm", "init");
    mkdirSync(join(repo, "sub"));
    assert.equal(spawnSync("git", ["-C", join(repo, "sub"), "init", "-q"]).status, 0);
  });

  const result = run("prepare");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(list(join(dir, "sources.lst")), ["kept.txt", "sub/"]);
  assert.ok(writable(join(scratch, "sub")), "a build can still write inside the directory");
});

test("prepare rejects a dangling link whose target sits under an in-copy link that leaves the copy", (t) => {
  const { root, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, ".gitignore"), "vendor\n");
    symlinkSync("vendor/missing.txt", join(repo, "through-link"));
    git("add", ".");
    git("commit", "-qm", "init");
  });
  const outside = outsideFile(root);
  // vendor is ignored, so only the dangling link is listed; its parent directory is the way out.
  symlinkSync(join(root, "outside"), join(scratch, "vendor"));

  const result = run("prepare");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /through-link -> .*outside\/missing\.txt/);
  assertUntouched(outside);
});

test("a refused prepare removes the lists of an earlier run, so verify cannot pass on them", (t) => {
  const { root, repo, dir, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });
  assert.equal(run("prepare").status, 0);
  // A new untracked link that leaves the copy appears before the next preparation.
  const outside = outsideFile(root);
  symlinkSync(outside, join(repo, "escape-link"));
  symlinkSync(outside, join(scratch, "escape-link"));

  const refused = run("prepare");
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(!existsSync(join(dir, "sources.lst")));
  assert.ok(!existsSync(join(dir, "deleted.lst")));
  assert.equal(run("verify").status, 2);
});

test("a prepare that cannot list the repository removes the lists of an earlier run", (t) => {
  const { root, repo, dir, scratch, run } = fixture(t, (repo, git) => {
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });
  assert.equal(run("prepare").status, 0);
  const notRepo = join(root, "not-a-repo");
  mkdirSync(notRepo);

  const failed = spawnSync(process.execPath, [...runtimeArgs, script, "prepare", notRepo, scratch, dir], { encoding: "utf8" });
  assert.equal(failed.status, 2, failed.stdout);
  assert.ok(!existsSync(join(dir, "sources.lst")));
  assert.ok(!existsSync(join(dir, "deleted.lst")));
  assert.equal(run("verify").status, 2);
});
