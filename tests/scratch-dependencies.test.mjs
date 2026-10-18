import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../references/check-scratch-dependencies.mjs", import.meta.url));
const runtimeArgs = process.versions.bun ? ["--no-env-file"] : [];

test("scratch preflight detects lost ancestor dependencies before execution", (t) => {
  const root = mkdtempSync(join(tmpdir(), "scratch-dependencies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installation = join(root, "project/node_modules");
  const worktree = join(root, "project/worktrees/worker");
  const scratch = join(root, "scratch");
  mkdirSync(join(installation, "fixture-preload"), { recursive: true });
  mkdirSync(join(worktree, "node_modules"), { recursive: true });
  mkdirSync(join(scratch, "node_modules"), { recursive: true });
  writeFileSync(join(installation, "fixture-preload/index.js"), "throw new Error('Resolution must not execute the package');\n");
  const run = (directory, ...packages) => spawnSync(process.execPath, [...runtimeArgs, script, directory, ...packages], { encoding: "utf8" });

  assert.equal(run(worktree, "fixture-preload").status, 0);
  const missing = run(scratch, "fixture-preload");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /fixture-preload/);
  assert.match(missing.stderr, /scratch/);

  symlinkSync(join(installation, "fixture-preload"), join(scratch, "node_modules/fixture-preload"));
  const ready = run(scratch, "fixture-preload");
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /project\/node_modules\/fixture-preload\/index.js/);
  assert.equal(run(scratch, "fixture-preload", "still-missing").status, 1);
});

test("scratch preflight requires a directory and at least one package", () => {
  const result = spawnSync(process.execPath, [...runtimeArgs, script], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
