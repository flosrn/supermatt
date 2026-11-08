import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const reference = (name) => fileURLToPath(new URL(`../references/${name}`, import.meta.url));
const runtimeArgs = process.versions.bun ? ["--no-env-file"] : [];
const script = (name, args, env = process.env) => spawnSync(process.execPath, [...runtimeArgs, reference(name), ...args], { encoding: "utf8", env });
const prepare = (source, scratch, env) => script("prepare-scratch-python.mjs", [source, scratch], env);
const check = (scratch) => script("check-scratch-containment.mjs", [scratch]);
const systemPython = "/usr/bin/python3";
const unsupported = process.platform === "darwin"
  ? "macOS /usr/bin/python3 is a launcher shim that cannot be copied"
  : !existsSync(systemPython)
    ? `${systemPython} is missing`
    : process.getuid?.() === 0 && "root can write system files";
const needsPython = { skip: unsupported };

// A user-owned interpreter is the system python3 binary copied into <root>/runtime/bin with a relative alias
// link and directories of restricted modes, the way uv or pyenv keeps one under the home directory. The source
// repository holds a virtualenv made with it, an editable install as a .pth path line, an editable finder
// module, and console scripts in both shebang forms.
function fixture(t, { interpreter = "user", bin = "runtime/bin", sourceName = "source", venvPath = ".venv" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "scratch-python-"));
  t.after(() => {
    spawnSync("chmod", ["-R", "u+rwx", root]);
    rmSync(root, { recursive: true, force: true });
  });
  let python = systemPython;
  if (interpreter === "user") {
    const name = basename(realpathSync(systemPython));
    python = join(root, bin, name);
    mkdirSync(join(root, bin), { recursive: true });
    copyFileSync(realpathSync(systemPython), python);
    chmodSync(python, 0o755);
    symlinkSync(name, join(root, bin, "python3-alias"));
    for (const [directory, mode] of [["lib/private", 0o700], ["share", 0o555]]) {
      mkdirSync(join(root, bin, "..", directory), { recursive: true });
      chmodSync(join(root, bin, "..", directory), mode);
    }
    if (spawnSync(python, ["-c", "pass"]).status !== 0) {
      t.skip("a copy of the system python3 cannot run");
      return null;
    }
  }
  const source = join(root, sourceName);
  for (const directory of ["src/engine", "vendor/other"]) {
    mkdirSync(join(source, directory), { recursive: true });
    writeFileSync(join(source, directory, "__init__.py"), "");
  }
  const venv = join(source, venvPath);
  const created = spawnSync(python, ["-m", "venv", "--without-pip", venv], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const sitePackages = join(venv, "lib", readdirSync(join(venv, "lib"))[0], "site-packages");
  writeFileSync(join(sitePackages, "engine.pth"), `${join(source, "src")}\n`);
  writeFileSync(join(sitePackages, "_editable_impl_other.pth"), "import _editable_impl_other\n");
  writeFileSync(join(sitePackages, "_editable_impl_other.py"), `import sys\nsys.path.append('${join(source, "vendor")}')\n`);
  mkdirSync(join(sitePackages, "engine-0.1.0.dist-info"));
  writeFileSync(join(sitePackages, "engine-0.1.0.dist-info/direct_url.json"), JSON.stringify({ url: pathToFileURL(source).href, dir_info: { editable: true } }));
  const body = "import engine, sys\nprint(engine.__file__)\nprint(sys.prefix)\n";
  const quoted = `'${join(venv, "bin/python").replaceAll("'", () => "'\\''")}'`;
  writeFileSync(join(venv, "bin/engine-where"), `#!${join(venv, "bin/python")}\n${body}`, { mode: 0o755 });
  writeFileSync(join(venv, "bin/engine-launch"), `#!/bin/sh\n'''exec' ${quoted} "$0" "$@"\n' '''\n${body}`, { mode: 0o755 });
  return { root, source, sitePackages: relative(source, sitePackages), python };
}

function copy(source, scratch) {
  const result = script("copy-scratch-tree.mjs", [source, scratch]);
  assert.equal(result.status, 0, result.stderr);
  return realpathSync(scratch);
}

function snapshot(directory) {
  const entries = {};
  const visit = (path, name) => {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) entries[name] = `link ${readlinkSync(path)}`;
    else if (stats.isDirectory()) {
      entries[name] = `directory ${stats.mode}`;
      for (const child of readdirSync(path)) visit(join(path, child), `${name}/${child}`);
    } else entries[name] = `file ${stats.mode} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  };
  visit(directory, ".");
  return entries;
}

// Runs a program from a directory outside both trees; a program that cannot start reports its error as stderr.
function run(command, args = []) {
  const result = spawnSync(command, args, { cwd: "/", encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.error ? result.error.message : result.stderr };
}

test("the helper makes a copied virtualenv with a user-owned interpreter run from scratch", needsPython, (t) => {
  const { root, source, sitePackages } = fixture(t) ?? {};
  if (!source) return;
  const outsidePaths = `${source}-shared/lib\n/mnt${source}/src\n`;
  writeFileSync(join(source, sitePackages, "paths.txt"), `${outsidePaths}${join(source, "src")}\n`);
  const binary = Buffer.concat([Buffer.from(join(source, "src")), Buffer.alloc(10000, 0x20), Buffer.from([0])]);
  writeFileSync(join(source, sitePackages, "engine.bin"), binary);
  const before = snapshot(source);
  const scratch = copy(source, join(root, "scratch"));
  assert.equal(check(scratch).status, 1);

  const result = prepare(source, scratch);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(check(scratch).status, 0, check(scratch).stderr);
  const imported = run(join(scratch, ".venv/bin/python"), ["-c", "import engine, other, sys; print(engine.__file__); print(other.__file__); print(sys._base_executable)"]);
  const [engine, other, base] = imported.stdout.trim().split("\n");
  assert.deepEqual([engine, other], [join(scratch, "src/engine/__init__.py"), join(scratch, "vendor/other/__init__.py")], imported.stderr);
  assert.ok(base.startsWith(join(scratch, ".venv/.scratch-python/runtime/bin/")), base);
  for (const name of ["engine-where", "engine-launch"]) {
    const console = run(join(scratch, ".venv/bin", name));
    assert.deepEqual(console.stdout.trim().split("\n"), [join(scratch, "src/engine/__init__.py"), join(scratch, ".venv")], `${name}: ${console.stderr}`);
  }
  assert.equal(readlinkSync(join(scratch, ".venv/bin/python")), readlinkSync(join(source, ".venv/bin/python")));
  const config = readFileSync(join(scratch, ".venv/pyvenv.cfg"), "utf8");
  for (const path of [join(root, "runtime/"), join(source, "/")]) assert.ok(!config.includes(path), config);
  assert.equal(readFileSync(join(scratch, sitePackages, "paths.txt"), "utf8"), `${outsidePaths}${join(scratch, "src")}\n`);
  assert.deepEqual(readFileSync(join(scratch, sitePackages, "engine.bin")), binary);
  for (const directory of ["lib/private", "share"]) {
    const mode = (path) => lstatSync(path).mode & 0o7777;
    assert.equal(mode(join(scratch, ".venv/.scratch-python/runtime", directory)), mode(join(root, "runtime", directory)), directory);
  }
  assert.deepEqual(snapshot(source), before);
});

test("a second helper run reports no change and leaves the scratch tree as it was", needsPython, (t) => {
  const { root, source } = fixture(t) ?? {};
  if (!source) return;
  const scratch = copy(source, join(root, "source (copy)"));
  assert.equal(prepare(source, scratch).status, 0);
  const prepared = snapshot(scratch);
  const again = prepare(source, scratch);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^Scratch Python ready: no change needed in 1 virtualenv under /);
  assert.deepEqual(snapshot(scratch), prepared);
});

test("a scratch path with a space or past the shebang limit gets /bin/sh exec launchers that run and an encoded file URL", needsPython, (t) => {
  const { root, source, sitePackages } = fixture(t) ?? {};
  if (!source) return;
  for (const name of ["scratch copy", "s".repeat(130)]) {
    const scratch = copy(source, join(root, name));
    assert.equal(prepare(source, scratch).status, 0);
    const url = JSON.parse(readFileSync(join(scratch, sitePackages, "engine-0.1.0.dist-info/direct_url.json"), "utf8")).url;
    assert.equal(fileURLToPath(url), scratch);
    for (const file of ["engine-where", "engine-launch"]) {
      const script = join(scratch, ".venv/bin", file);
      assert.match(readFileSync(script, "utf8"), /^#!\/bin\/sh\n'''exec' '[^\n]*\/\.venv\/bin\/python' "\$0" "\$@"\n' '''\n/);
      const result = run(script);
      assert.deepEqual(result.stdout.trim().split("\n"), [join(scratch, "src/engine/__init__.py"), join(scratch, ".venv")], `${file}: ${result.stderr}`);
    }
    assert.equal(check(scratch).status, 0, check(scratch).stderr);
  }
});

test("the helper points file URLs of the repository at scratch, in Python's and uv's encodings", needsPython, (t) => {
  const { root, source, sitePackages } = fixture(t, { sourceName: "source (dir)" }) ?? {};
  if (!source) return;
  const pythonUri = (path) => spawnSync(systemPython, ["-c", "import pathlib, sys; print(pathlib.Path(sys.argv[1]).as_uri())", path], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(source, sitePackages, "python-url.txt"), `${pythonUri(source)}\n`);
  const scratch = copy(source, join(root, "scratch (copy)"));
  const result = prepare(source, scratch);
  assert.equal(result.status, 0, result.stderr);
  const url = JSON.parse(readFileSync(join(scratch, sitePackages, "engine-0.1.0.dist-info/direct_url.json"), "utf8")).url;
  assert.equal(fileURLToPath(url), scratch);
  assert.equal(readFileSync(join(scratch, sitePackages, "python-url.txt"), "utf8"), `${pythonUri(scratch)}\n`);
  const imported = run(join(scratch, ".venv/bin/python"), ["-c", "import engine; print(engine.__file__)"]);
  assert.equal(imported.stdout.trim(), join(scratch, "src/engine/__init__.py"), imported.stderr);
});

test("the helper refuses a linked bin directory without writing through it", needsPython, (t) => {
  const { root, source } = fixture(t) ?? {};
  if (!source) return;
  const before = snapshot(source);
  const scratch = copy(source, join(root, "scratch"));
  rmSync(join(scratch, ".venv/bin"), { recursive: true });
  symlinkSync(join(source, ".venv/bin"), join(scratch, ".venv/bin"));
  const result = prepare(source, scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^Scratch Python preparation failed: .*\/scratch\/\.venv\/bin is not a directory$/m);
  assert.deepEqual(snapshot(source), before);
});

test("a virtualenv under a directory holding a quote keeps console scripts that run", needsPython, (t) => {
  const { root, source } = fixture(t, { venvPath: "apps/it's-app/.venv" }) ?? {};
  if (!source) return;
  const scratch = copy(source, join(root, "scratch copy"));
  const result = prepare(source, scratch);
  assert.equal(result.status, 0, result.stderr);
  const venv = join(scratch, "apps/it's-app/.venv");
  for (const file of ["engine-where", "engine-launch"]) {
    const console = run(join(venv, "bin", file));
    assert.deepEqual(console.stdout.trim().split("\n"), [join(scratch, "src/engine/__init__.py"), venv], `${file}: ${console.stderr}`);
  }
  assert.equal(check(scratch).status, 0, check(scratch).stderr);
});

test("the helper rewrites a repository path that Python wrote with JSON or ASCII escapes", needsPython, (t) => {
  const sourceName = "source-\u00e9\u30e6\u{1f600}";
  const { root, source, sitePackages } = fixture(t, { sourceName }) ?? {};
  if (!source) return;
  const escaped = (format, path) => spawnSync(systemPython, ["-c", `import json, sys; print(${format})`, path], { encoding: "utf8" }).stdout.trim();
  for (const name of ["jsonfinder", "asciifinder"]) {
    mkdirSync(join(source, name, name), { recursive: true });
    writeFileSync(join(source, name, name, "__init__.py"), "");
    writeFileSync(join(source, sitePackages, `_editable_impl_${name}.pth`), `import _editable_impl_${name}\n`);
  }
  // json.dumps escapes JSON text, which a finder reads with json; ascii() escapes a Python literal.
  writeFileSync(join(source, sitePackages, "jsonfinder.json"), escaped("json.dumps({'path': sys.argv[1]})", join(source, "jsonfinder")));
  writeFileSync(join(source, sitePackages, "_editable_impl_jsonfinder.py"), "import json, os, sys\nsys.path.append(json.load(open(os.path.join(os.path.dirname(__file__), 'jsonfinder.json')))['path'])\n");
  writeFileSync(join(source, sitePackages, "_editable_impl_asciifinder.py"), `import sys\nsys.path.append(${escaped("ascii(sys.argv[1])", join(source, "asciifinder"))})\n`);
  const scratch = copy(source, join(root, `${sourceName} copy`));
  const result = prepare(source, scratch);
  assert.equal(result.status, 0, result.stderr);
  const imported = run(join(scratch, ".venv/bin/python"), ["-c", "import jsonfinder, asciifinder; print(jsonfinder.__file__); print(asciifinder.__file__)"]);
  assert.deepEqual(imported.stdout.trim().split("\n"), [join(scratch, "jsonfinder/jsonfinder/__init__.py"), join(scratch, "asciifinder/asciifinder/__init__.py")], imported.stderr);
  assert.match(prepare(source, scratch).stdout, /^Scratch Python ready: no change needed/);
});

test("the helper refuses a virtualenv path holding a control character, without writing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "scratch-python-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["source", "scratch"]) {
    const venv = join(root, directory, "apps/line\napp/.venv");
    mkdirSync(join(venv, "lib/python3/site-packages"), { recursive: true });
    writeFileSync(join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
    writeFileSync(join(venv, "lib/python3/site-packages/engine.pth"), `${join(root, "source/src")}\n`);
  }
  const before = snapshot(root);
  const result = prepare(join(root, "source"), join(root, "scratch"));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^Scratch Python preparation failed: virtualenv path ".*apps\/line\\napp\/\.venv" holds a control character/);
  assert.deepEqual(snapshot(root), before);
});

test("the helper refuses a scratch or repository path holding a quote, backslash, or control character, without writing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "scratch-python-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = (directory, repository) => {
    mkdirSync(join(directory, ".venv/lib/python3/site-packages"), { recursive: true });
    writeFileSync(join(directory, ".venv/pyvenv.cfg"), "home = /usr/bin\n");
    writeFileSync(join(directory, ".venv/lib/python3/site-packages/engine.pth"), `${join(repository, "src")}\n`);
  };
  const cases = [["source", "it's copy"], ["source", 'say "hi"'], ["source", "back\\slash"], ["source", "line\nbreak"], ["source", "tab\there"], ['source "q"', "scratch"]];
  for (const [repository, scratch] of cases) {
    environment(join(root, repository), join(root, repository));
    environment(join(root, scratch), join(root, repository));
  }
  const before = snapshot(root);
  for (const [repository, scratch] of cases) {
    const result = prepare(join(root, repository), join(root, scratch));
    assert.equal(result.status, 1, `${scratch}: ${result.stdout}`);
    // Bun's realpathSync fails on a path holding a backslash, so under Bun that refusal comes earlier, as ENOENT.
    const reason = process.versions.bun && scratch.includes("\\") ? "ENOENT" : "holds a quote, backslash, or control character";
    assert.match(result.stderr, new RegExp(`^Scratch Python preparation failed: .*${reason}`));
  }
  assert.deepEqual(snapshot(root), before);
});

test("a virtualenv linked to a locked system interpreter keeps its link and still imports from scratch", needsPython, (t) => {
  const { root, source } = fixture(t, { interpreter: "system" });
  const scratch = copy(source, join(root, "scratch"));
  const links = () => readdirSync(join(scratch, ".venv/bin")).filter((name) => lstatSync(join(scratch, ".venv/bin", name)).isSymbolicLink()).map((name) => `${name} -> ${readlinkSync(join(scratch, ".venv/bin", name))}`);
  const before = links();
  const result = prepare(source, scratch);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(links(), before);
  assert.equal(existsSync(join(scratch, ".venv/.scratch-python")), false);
  assert.equal(check(scratch).status, 0, check(scratch).stderr);
  const imported = run(join(scratch, ".venv/bin/python"), ["-c", "import engine; print(engine.__file__)"]);
  assert.equal(imported.stdout.trim(), join(scratch, "src/engine/__init__.py"), imported.stderr);
});

test("the helper refuses a scratch inside the repository, a linked or missing scratch root, or a file, without writing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "scratch-python-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const environment = (directory) => {
    mkdirSync(join(directory, ".venv/lib/python3/site-packages"), { recursive: true });
    writeFileSync(join(directory, ".venv/pyvenv.cfg"), `home = ${join(root, "runtime/bin")}\n`);
    writeFileSync(join(directory, ".venv/lib/python3/site-packages/engine.pth"), `${join(source, "src")}\n`);
  };
  environment(source);
  environment(join(source, "inner"));
  environment(join(root, "copy"));
  symlinkSync(join(root, "copy"), join(root, "alias"));
  writeFileSync(join(root, "file"), "");
  const before = snapshot(root);
  for (const [repository, scratch, reason] of [
    [source, source, /outside the repository/],
    [source, join(source, "inner"), /outside the repository/],
    [source, join(root, "alias"), /scratch root is a symlink/],
    [source, join(root, "missing"), /scratch directory does not exist/],
    [source, join(root, "file"), /scratch root is not a directory/],
    [join(root, "file"), join(root, "copy"), /repository must be a directory/],
  ]) {
    const result = prepare(repository, scratch);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`^Scratch Python preparation failed: .*${reason.source}`));
  }
  assert.deepEqual(snapshot(root), before);
});

test("the helper fails when a virtualenv's interpreter is missing, dangling, does not start, or runs another environment", (t) => {
  const root = mkdtempSync(join(tmpdir(), "scratch-python-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "source"));
  const scratch = join(root, "scratch");
  const python = join(scratch, ".venv/bin/python");
  mkdirSync(join(scratch, ".venv/bin"), { recursive: true });
  writeFileSync(join(scratch, ".venv/pyvenv.cfg"), "home = /usr/bin\n");
  for (const [setup, reason] of [
    [() => {}, /virtualenv has no bin\/python: .*\/scratch\/\.venv$/],
    [() => symlinkSync(join(root, "removed/bin/python3"), python), /dangling link \(target missing\): .*\.venv\/bin\/python -> .*removed\/bin\/python3$/],
    [() => writeFileSync(python, "#!/bin/sh\necho broken >&2\nexit 3\n", { mode: 0o755 }), /\.venv\/bin\/python does not start: broken$/],
    [() => writeFileSync(python, "#!/bin/sh\necho /\n", { mode: 0o755 }), /\.venv\/bin\/python runs with sys\.prefix \/, not /],
  ]) {
    rmSync(python, { force: true });
    setup();
    const result = prepare(join(root, "source"), scratch);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`^Scratch Python preparation failed: .*${reason.source}`, "m"));
  }
});

test("a scratch tree without a virtualenv needs no change", (t) => {
  const root = mkdtempSync(join(tmpdir(), "scratch-python-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "source"));
  mkdirSync(join(root, "scratch/lib"), { recursive: true });
  const result = prepare(join(root, "source"), join(root, "scratch"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Scratch Python ready: no virtualenv under /);
});

test("a runtime copy left by an interrupted run is replaced by a complete one", needsPython, (t) => {
  const { root, source } = fixture(t) ?? {};
  if (!source) return;
  const scratch = copy(source, join(root, "scratch"));
  mkdirSync(join(scratch, ".venv/.scratch-python/runtime/bin"), { recursive: true });
  writeFileSync(join(scratch, ".venv/.scratch-python/runtime/bin/partial"), "");
  chmodSync(join(scratch, ".venv/.scratch-python/runtime/bin"), 0o555);
  writeFileSync(join(scratch, ".venv/bin/engine-where.scratch-python-tmp"), "partial");
  const result = prepare(source, scratch);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(scratch, ".venv/.scratch-python/runtime/bin")), readdirSync(join(root, "runtime/bin")));
  assert.equal(check(scratch).status, 0, check(scratch).stderr);
});

test("the helper refuses a runtime it cannot copy: one outside a bin directory or one holding scratch, the repository, or home", needsPython, (t) => {
  for (const [bin, reason, home] of [
    ["runtime/tools", /interpreter of .*\/scratch\/\.venv is not in a bin directory: /],
    ["bin", /interpreter runtime .* holds the scratch tree/],
    ["source/bin", /interpreter runtime .*\/source holds the repository/],
    ["runtime/bin", /interpreter runtime .*\/runtime holds the home directory/, "runtime/home"],
  ]) {
    const { root, source } = fixture(t, { bin }) ?? {};
    if (!source) return;
    const scratch = copy(source, join(root, "scratch"));
    const before = snapshot(scratch);
    const result = prepare(source, scratch, home && { ...process.env, HOME: join(root, home) });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, reason);
    assert.deepEqual(snapshot(scratch), before);
  }
});

test("the helper writes no runtime through a linked .scratch-python and leaves links to other places for the check", needsPython, (t) => {
  const { root, source } = fixture(t) ?? {};
  if (!source) return;
  let scratch = copy(source, join(root, "linked"));
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), join(scratch, ".venv/.scratch-python"));
  let result = prepare(source, scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /\.venv\/\.scratch-python is not a directory/);
  assert.deepEqual(readdirSync(join(root, "elsewhere")), []);

  scratch = copy(source, join(root, "scratch"));
  writeFileSync(join(root, "elsewhere/tool"), "");
  symlinkSync(join(root, "elsewhere/tool"), join(scratch, ".venv/bin/tool"));
  result = prepare(source, scratch);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(join(scratch, ".venv/bin/tool")), join(root, "elsewhere/tool"));
  assert.match(check(scratch).stderr, /symlink escapes scratch: .*\.venv\/bin\/tool -> /);
});
