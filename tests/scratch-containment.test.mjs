import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../references/check-scratch-containment.mjs", import.meta.url));
const runtimeArgs = process.versions.bun ? ["--no-env-file"] : [];
const run = (...args) => spawnSync(process.execPath, [...runtimeArgs, script, ...args], { encoding: "utf8" });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "scratch containment "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "copy");
  mkdirSync(join(scratch, "data"), { recursive: true });
  return { root, scratch };
}

test("scratch containment permits internal links and directory cycles", (t) => {
  const { scratch } = fixture(t);
  writeFileSync(join(scratch, "data/value"), "inside");
  symlinkSync("data/value", join(scratch, "value"));
  symlinkSync("..", join(scratch, "data/parent"));
  const result = run(scratch);
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
