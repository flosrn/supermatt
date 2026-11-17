import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function sitePackages(scratch) {
  const path = join(scratch, ".venv/lib/python3.12/site-packages");
  mkdirSync(path, { recursive: true });
  return path;
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

test("scratch containment blocks editable .pth paths escaping to another checkout", (t) => {
  const { root, scratch } = fixture(t);
  const outside = join(root, "original checkout");
  mkdirSync(outside);
  const pth = join(sitePackages(scratch), "editable.pth");
  for (const target of [outside, relative(sitePackages(scratch), outside)]) {
    writeFileSync(pth, `${target}\n`);
    const result = run(scratch);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /\.pth path escapes scratch/);
    assert.ok(result.stderr.includes(pth), result.stderr);
    assert.ok(result.stderr.includes(outside), result.stderr);
  }
});

test("scratch containment permits in-tree .pth paths and ignores comments and import lines", (t) => {
  const { scratch } = fixture(t);
  writeFileSync(join(sitePackages(scratch), "editable.pth"), `# comment\n\nimport sys; sys.path.append('/outside')\nimport\tsite\n.\n${scratch}\n`);
  const result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
});

test("scratch containment blocks direct_url.json pointing to another checkout", (t) => {
  const { root, scratch } = fixture(t);
  const outside = join(root, "original checkout");
  mkdirSync(outside);
  const metadata = join(scratch, "data/direct_url.json");
  writeFileSync(metadata, JSON.stringify({ url: pathToFileURL(outside).href, dir_info: { editable: true } }));
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /direct_url\.json path escapes scratch/);
  assert.ok(result.stderr.includes(metadata), result.stderr);
  assert.ok(result.stderr.includes(outside), result.stderr);
});

test("scratch containment permits in-tree and non-file direct_url.json sources", (t) => {
  const { scratch } = fixture(t);
  const metadata = join(scratch, "data/direct_url.json");
  for (const url of [pathToFileURL(scratch).href, "https://example.org/package.whl"]) {
    writeFileSync(metadata, JSON.stringify({ url }));
    const result = run(scratch);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("scratch containment resolves editable targets through symlinked ancestors", (t) => {
  const { root, scratch } = fixture(t);
  const outside = join(root, "original");
  mkdirSync(outside);
  const alias = join(root, "alias");
  symlinkSync(outside, alias);
  const pth = join(sitePackages(scratch), "editable.pth");
  writeFileSync(pth, `${alias}\n`);
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(outside), result.stderr);
});

test("scratch containment permits editable metadata targeting a locked system file", {
  skip: !existsSync("/usr/bin/python3") || process.getuid?.() === 0,
}, (t) => {
  const { scratch } = fixture(t);
  writeFileSync(join(sitePackages(scratch), "system.pth"), "/usr/bin/python3\n");
  writeFileSync(join(scratch, "data/direct_url.json"), JSON.stringify({ url: "file:///usr/bin/python3" }));
  const result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
});

test("scratch containment checks linked editable metadata inside the tree", (t) => {
  const { root, scratch } = fixture(t);
  const outside = join(root, "original");
  mkdirSync(outside);
  const contents = join(scratch, "data/metadata");
  for (const [name, value] of [
    ["editable.pth", `${outside}\n`],
    ["direct_url.json", JSON.stringify({ url: pathToFileURL(outside).href })],
  ]) {
    writeFileSync(contents, value);
    const link = join(sitePackages(scratch), name);
    symlinkSync(relative(sitePackages(scratch), contents), link);
    const result = run(scratch);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(link), result.stderr);
    assert.ok(result.stderr.includes(outside), result.stderr);
    rmSync(link);
  }
});

test("scratch containment ignores binary .pth model weights outside Python site directories", (t) => {
  const { scratch } = fixture(t);
  writeFileSync(join(scratch, "data/model.pth"), Buffer.from([0x80, 0, 0xff, 10]));
  const result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
});

test("scratch containment permits absent in-tree metadata targets but blocks absent external targets", (t) => {
  const { root, scratch } = fixture(t);
  for (const [name, contents] of [
    ["editable.pth", (target) => `${target}\n`],
    ["direct_url.json", (target) => JSON.stringify({ url: pathToFileURL(target).href })],
  ]) {
    const metadata = join(sitePackages(scratch), name);
    writeFileSync(metadata, contents(join(scratch, "missing")));
    assert.equal(run(scratch).status, 0);
    const target = join(root, "missing-original/package");
    writeFileSync(metadata, contents(target));
    const result = run(scratch);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(metadata), result.stderr);
    assert.ok(result.stderr.includes(target), result.stderr);
    rmSync(metadata);
  }
});

test("scratch containment checks dist-packages and missing targets behind symlinked ancestors", (t) => {
  const { root, scratch } = fixture(t);
  const packages = join(scratch, "lib/dist-packages");
  mkdirSync(packages, { recursive: true });
  const outside = join(root, "original");
  mkdirSync(outside);
  const alias = join(root, "alias");
  symlinkSync(outside, alias);
  const pth = join(packages, "editable.pth");
  writeFileSync(pth, `${alias}/missing\n`);
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(pth), result.stderr);
  assert.ok(result.stderr.includes(join(outside, "missing")), result.stderr);
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
  assert.match(result.stderr, /\.pth path escapes scratch: .*site-packages\/_editable_impl_engine\.pth -> .*source\/src;/m);
});

test("scratch containment inspects a .pth linked to an internal regular file", (t) => {
  const { root, scratch } = fixture(t);
  const { sitePackages } = environmentFiles(scratch);
  const target = join(scratch, "data/editable-path.txt");
  writeFileSync(target, `${join(root, "source/src")}\n`);
  symlinkSync(relative(sitePackages, target), join(sitePackages, "engine.pth"));
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\.pth path escapes scratch: .*site-packages\/engine\.pth -> .*source\/src;/m);
});

test("scratch containment skips a .pth that is not a regular file, as Python does", (t) => {
  const { root, scratch } = fixture(t);
  const { sitePackages } = environmentFiles(scratch);
  mkdirSync(join(scratch, "data/folder"));
  symlinkSync(relative(sitePackages, join(scratch, "data/folder")), join(sitePackages, "folder.pth"));
  mkdirSync(join(sitePackages, "directory.pth"));
  assert.equal(spawnSync("mkfifo", [join(sitePackages, "pipe.pth")]).status, 0);
  let result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), join(sitePackages, "outside.pth"));
  result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /symlink escapes scratch: .*site-packages\/outside\.pth -> .*elsewhere$/m);
});

test("scratch containment ends a .pth line wherever Python's str.splitlines does", (t) => {
  const { root, scratch } = fixture(t);
  const { sitePackages } = environmentFiles(scratch);
  const outside = join(root, "source/src");
  const pth = join(sitePackages, "engine.pth");
  for (const separator of ["\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]) {
    writeFileSync(pth, `# harmless${separator}${outside}${separator}`);
    const result = run(scratch);
    assert.equal(result.status, 1, `${JSON.stringify(separator)}: ${result.stdout}`);
    assert.ok(result.stderr.includes(`.pth path escapes scratch: ${realpathSync(pth)} -> ${join(realpathSync(root), "source/src")};`), result.stderr);
  }
});

test("scratch containment resolves a virtualenv's .pth lines against its site directory as Python names it", (t) => {
  const { root, scratch } = fixture(t);
  const { venv } = environmentFiles(scratch);
  // lib links deep inside scratch, so five steps up stay inside from the real directory but leave from the named one.
  const storage = join(scratch, "store/a/b/c/d");
  mkdirSync(join(storage, "python3.12/site-packages"), { recursive: true });
  writeFileSync(join(storage, "python3.12/site-packages/engine.pth"), "../../../../../external\n");
  rmSync(join(venv, "lib"), { recursive: true });
  symlinkSync(relative(venv, storage), join(venv, "lib"));
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(`.pth path escapes scratch: ${join(realpathSync(venv), "lib/python3.12/site-packages/engine.pth")} -> ${join(realpathSync(root), "external")};`), result.stderr);
});

test("scratch containment checks the .pth files of a site directory linked inside scratch", (t) => {
  const { root, scratch } = fixture(t);
  const { venv, sitePackages } = environmentFiles(scratch);
  const outside = join(root, "source/src");
  for (const name of ["site-packages", "dist-packages"]) {
    const storage = join(scratch, `package-storage-${name}`);
    mkdirSync(storage);
    writeFileSync(join(storage, "engine.pth"), `${outside}\n`);
    const site = join(venv, "lib/python3.12", name);
    rmSync(site, { recursive: true, force: true });
    symlinkSync(relative(join(venv, "lib/python3.12"), storage), site);
    const result = run(scratch);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`\\.pth path escapes scratch: .*python3\\.12/${name}/engine\\.pth -> .*source/src;`, "m"));
    rmSync(site);
    rmSync(storage, { recursive: true });
  }
  mkdirSync(sitePackages);
});

test("scratch containment permits an archive install record outside scratch but not a directory install", (t) => {
  const { root, scratch } = fixture(t);
  const { sitePackages } = environmentFiles(scratch);
  const metadata = join(sitePackages, "pip-26.2.2.dist-info/direct_url.json");
  mkdirSync(join(sitePackages, "pip-26.2.2.dist-info"));
  const wheel = pathToFileURL(join(root, "build/pip-26.2.2-py3-none-any.whl")).href;
  writeFileSync(metadata, JSON.stringify({ archive_info: { hash: "sha256=fd7f" }, url: wheel }));
  let result = run(scratch);
  assert.equal(result.status, 0, result.stderr);
  const directory = pathToFileURL(join(root, "source")).href;
  for (const record of [
    { dir_info: { editable: true } },
    { dir_info: {} },
    { archive_info: {}, dir_info: { editable: true } },
    { archive_info: {}, dir_info: null },
    { archive_info: {}, dir_info: false },
    { archive_info: {}, vcs_info: { vcs: "git" } },
    { archive_info: null },
  ]) {
    writeFileSync(metadata, JSON.stringify({ ...record, url: directory }));
    result = run(scratch);
    assert.equal(result.status, 1, `${JSON.stringify(record)}: ${result.stdout}`);
    assert.match(result.stderr, /direct_url\.json path escapes scratch: .*pip-26\.2\.2\.dist-info\/direct_url\.json -> .*\/source$/m);
  }
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
  assert.ok(result.stderr.includes(`shebang points outside scratch: ${join(realpathSync(venv), "bin/engine")} -> ${scratch}\nx/python`), result.stderr);
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
