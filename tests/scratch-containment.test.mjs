import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../references/check-scratch-containment.mjs", import.meta.url));
const runtimeArgs = process.versions.bun ? ["--no-env-file"] : [];
const run = (scratch, env) => spawnSync(process.execPath, [...runtimeArgs, script, scratch], { encoding: "utf8", env });
const systemPython = "/usr/bin/python3";
const needsSystemPython = {
  skip: !existsSync(systemPython) ? `${systemPython} is missing` : process.getuid?.() === 0 && "root can write system files",
};

function fixture(t, prefix = "scratch containment ") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "copy");
  mkdirSync(join(scratch, "data"), { recursive: true });
  return { root, scratch };
}

function virtualenv(scratch, interpreter) {
  mkdirSync(join(scratch, ".venv/bin"), { recursive: true });
  symlinkSync(interpreter, join(scratch, ".venv/bin/python"));
  symlinkSync("python", join(scratch, ".venv/bin/python3"));
}

function environmentFiles(scratch) {
  const venv = join(scratch, ".venv");
  const sitePackages = join(venv, "lib/python3.12/site-packages");
  mkdirSync(join(venv, "bin"), { recursive: true });
  mkdirSync(sitePackages, { recursive: true });
  writeFileSync(join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
  return { venv, sitePackages };
}

test("scratch containment permits internal links and directory cycles", (t) => {
  const { scratch } = fixture(t);
  writeFileSync(join(scratch, "data/value"), "inside");
  symlinkSync("data/value", join(scratch, "value"));
  symlinkSync("..", join(scratch, "data/parent"));
  const result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
});

test("scratch containment permits a virtualenv linking to a system interpreter", needsSystemPython, (t) => {
  const { scratch } = fixture(t);
  virtualenv(scratch, systemPython);
  const result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
});

test("scratch containment blocks a virtualenv linking to a system file the user can write", (t) => {
  const { scratch } = fixture(t);
  virtualenv(scratch, "/dev/null");
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /symlink escapes scratch: .*python(?:3)? -> \/dev\/null/);
});

test("scratch containment blocks a virtualenv linking to an interpreter in another writable checkout", (t) => {
  const { root, scratch } = fixture(t);
  const interpreter = join(root, "other-checkout/.venv/bin/python3");
  mkdirSync(join(root, "other-checkout/.venv/bin"), { recursive: true });
  writeFileSync(interpreter, "unchanged");
  virtualenv(scratch, interpreter);
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /symlink escapes scratch: .*python(?:3)? -> .*other-checkout/);
  assert.equal(readFileSync(interpreter, "utf8"), "unchanged");
});

test("scratch containment blocks a link to a read-only system directory", needsSystemPython, (t) => {
  const { scratch } = fixture(t);
  symlinkSync("/usr/bin", join(scratch, "data/bin"));
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /symlink escapes scratch: .*bin -> \/usr\/bin/);
});

test("scratch containment blocks a virtualenv linking to a read-only interpreter the user owns", (t) => {
  const { root, scratch } = fixture(t);
  const interpreter = join(root, "toolchain/python3");
  mkdirSync(join(root, "toolchain"));
  writeFileSync(interpreter, "unchanged");
  chmodSync(interpreter, 0o444);
  virtualenv(scratch, interpreter);
  const result = run(scratch, { ...process.env, HOME: join(root, "missing-home") });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /symlink escapes scratch: .*python(?:3)? -> .*toolchain\/python3/);
});

test("scratch containment blocks a system interpreter inside the user's linked home", needsSystemPython, (t) => {
  const { root, scratch } = fixture(t);
  virtualenv(scratch, systemPython);
  symlinkSync("/usr", join(root, "home"));
  const result = run(scratch, { ...process.env, HOME: join(root, "home") });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /symlink escapes scratch: .*python(?:3)? -> \/usr\/bin\//);
});

test("scratch containment permits a system interpreter when the user's home does not exist", needsSystemPython, (t) => {
  const { root, scratch } = fixture(t);
  virtualenv(scratch, systemPython);
  const result = run(scratch, { ...process.env, HOME: join(root, "missing-home") });
  assert.equal(result.status, 0, result.stderr);
});

test("scratch containment blocks absolute and relative links to a sibling tree", (t) => {
  const { root, scratch } = fixture(t);
  const outside = join(root, "copy-outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "value"), "unchanged");
  for (const target of [outside, relative(join(scratch, "data"), outside)]) {
    const link = join(scratch, "data/escape");
    symlinkSync(target, link);
    const result = run(scratch);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /symlink escapes scratch/);
    assert.equal(readFileSync(join(outside, "value"), "utf8"), "unchanged");
    rmSync(link);
  }
});

test("scratch containment names a dangling link and refuses a linked root", (t) => {
  const { root, scratch } = fixture(t);
  symlinkSync("missing", join(scratch, "data/broken"));
  let result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /dangling link \(target missing in scratch\): .*copy\/data\/broken -> missing$/m);
  rmSync(join(scratch, "data/broken"));
  const alias = join(root, "alias");
  symlinkSync(scratch, alias);
  result = run(alias);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scratch root is a symlink/);
});

test("scratch containment blocks a copied linked worktree's .git pointer file", (t) => {
  const { root, scratch } = fixture(t);
  writeFileSync(join(scratch, ".git"), `gitdir: ${join(root, "main/.git/worktrees/topic")}\n`);
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\.git is not a directory: .*copy\/\.git$/m);
});

test("scratch containment blocks a nested .git file or link and permits .git directories", (t) => {
  const { root, scratch } = fixture(t);
  mkdirSync(join(scratch, ".git/objects"), { recursive: true });
  mkdirSync(join(scratch, "data/vendor/.git"), { recursive: true });
  assert.equal(run(scratch).status, 0);
  rmSync(join(scratch, "data/vendor/.git"), { recursive: true });
  writeFileSync(join(scratch, "data/vendor/.git"), `gitdir: ${join(root, "main/.git/modules/vendor")}\n`);
  let result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\.git is not a directory: .*copy\/data\/vendor\/\.git$/m);
  rmSync(join(scratch, "data/vendor/.git"));
  writeFileSync(join(scratch, "data/pointer"), `gitdir: ${join(root, "main/.git")}\n`);
  symlinkSync("../pointer", join(scratch, "data/vendor/.git"));
  result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\.git is not a directory: .*copy\/data\/vendor\/\.git$/m);
});

test("scratch containment blocks a virtualenv .pth path line outside scratch and permits import lines", (t) => {
  const { root, scratch } = fixture(t);
  const { sitePackages } = environmentFiles(scratch);
  symlinkSync(scratch, join(root, "alias"));
  const climb = "../".repeat(20);
  const lines = ["# comment", `# ${climb}outside`, "", "import os", `import sys # ${climb}outside`, "../../../../data", join(scratch, "data"), join(root, "alias/data"), join(root, "alias/missing/lib")];
  writeFileSync(join(sitePackages, "inside.pth"), `${lines.join("\n")}\n`);
  let result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
  const source = join(root, "source/src");
  writeFileSync(join(sitePackages, "_editable_impl_engine.pth"), `${source}\n`);
  result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\.pth path points outside scratch: .*site-packages\/_editable_impl_engine\.pth -> .*source\/src$/m);
});

test("scratch containment blocks a virtualenv script whose shebang names an interpreter outside scratch", (t) => {
  const { root, scratch } = fixture(t, "scratch-containment-");
  const { venv } = environmentFiles(scratch);
  symlinkSync(scratch, join(root, "alias"));
  writeFileSync(join(venv, "bin/inside"), `#!${join(venv, "bin/python")}\nprint()\n`);
  writeFileSync(join(venv, "bin/aliased"), `#!${join(root, "alias/.venv/bin/python")}\nprint()\n`);
  writeFileSync(join(venv, "bin/relative"), "#!python\nprint()\n");
  writeFileSync(join(venv, "bin/data"), "no shebang\n");
  let result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
  const interpreter = join(root, "source/.venv/bin/python");
  writeFileSync(join(venv, "bin/engine"), `#!${interpreter}\nprint()\n`);
  result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /shebang points outside scratch: .*\.venv\/bin\/engine -> .*source\/\.venv\/bin\/python$/m);
});

test("scratch containment reads the interpreter of a /bin/sh exec launcher script in each quoting", (t) => {
  const { root, scratch } = fixture(t, "scratch-containment-");
  const { venv } = environmentFiles(scratch);
  const launcher = (python) => `#!/bin/sh\n'''exec' ${python} "$0" "$@"\n' '''\nprint()\n`;
  writeFileSync(join(venv, "bin/inside"), launcher(`'${join(venv, "bin/python")}'`));
  let result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
  const interpreter = join(root, "source/.venv/bin/python");
  for (const quoted of [`'${interpreter}'`, `"${interpreter}"`, interpreter]) {
    writeFileSync(join(venv, "bin/engine"), launcher(quoted));
    result = run(scratch);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /shebang points outside scratch: .*\.venv\/bin\/engine -> .*source\/\.venv\/bin\/python$/m);
  }
  writeFileSync(join(venv, "bin/engine"), launcher(`'${scratch}'\\''x/python'`));
  result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /shebang points outside scratch: .*\.venv\/bin\/engine -> .*\/copy'x\/python$/m);
  writeFileSync(join(venv, "bin/engine"), launcher(`'${scratch}\nx/python'`));
  result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(`shebang points outside scratch: ${join(venv, "bin/engine")} -> ${scratch}\nx/python`), result.stderr);
});

test("scratch containment permits system shebangs but not another virtualenv's link to a system interpreter", needsSystemPython, (t) => {
  const { root, scratch } = fixture(t, "scratch-containment-");
  const { venv } = environmentFiles(scratch);
  writeFileSync(join(venv, "bin/env-script"), "#!/usr/bin/env python3\nprint()\n");
  writeFileSync(join(venv, "bin/system-script"), `#!${systemPython} -I\nprint()\n`);
  let result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
  const source = join(root, "source");
  virtualenv(source, systemPython);
  writeFileSync(join(venv, "bin/engine"), `#!${join(source, ".venv/bin/python")}\nprint()\n`);
  result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /shebang points outside scratch: .*\.venv\/bin\/engine -> .*source\/\.venv\/bin\/python$/m);
  writeFileSync(join(venv, "bin/engine"), "#!/dev/null\nprint()\n");
  result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /shebang points outside scratch: .*\.venv\/bin\/engine -> \/dev\/null$/m);
});
