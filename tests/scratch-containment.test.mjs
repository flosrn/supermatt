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

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "scratch containment "));
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
  assert.match(result.stderr, /symlink escapes scratch: .*python -> \/dev\/null/);
});

test("scratch containment blocks a virtualenv linking to an interpreter in another writable checkout", (t) => {
  const { root, scratch } = fixture(t);
  const interpreter = join(root, "other-checkout/.venv/bin/python3");
  mkdirSync(join(root, "other-checkout/.venv/bin"), { recursive: true });
  writeFileSync(interpreter, "unchanged");
  virtualenv(scratch, interpreter);
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /symlink escapes scratch: .*python -> .*other-checkout/);
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
  assert.match(result.stderr, /symlink escapes scratch: .*python -> .*toolchain\/python3/);
});

test("scratch containment blocks a system interpreter inside the user's linked home", needsSystemPython, (t) => {
  const { root, scratch } = fixture(t);
  virtualenv(scratch, systemPython);
  symlinkSync("/usr", join(root, "home"));
  const result = run(scratch, { ...process.env, HOME: join(root, "home") });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /symlink escapes scratch: .*python -> \/usr\/bin\//);
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

test("scratch containment refuses unresolved links and a linked root", (t) => {
  const { root, scratch } = fixture(t);
  symlinkSync("missing", join(scratch, "broken"));
  assert.equal(run(scratch).status, 1);
  rmSync(join(scratch, "broken"));
  const alias = join(root, "alias");
  symlinkSync(scratch, alias);
  const result = run(alias);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scratch root is a symlink/);
});
