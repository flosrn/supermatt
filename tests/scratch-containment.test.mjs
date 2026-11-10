import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

test("scratch containment blocks editable .pth paths escaping to another checkout", (t) => {
  const { root, scratch } = fixture(t);
  const outside = join(root, "original checkout");
  mkdirSync(outside);
  const pth = join(scratch, "data/editable.pth");
  for (const target of [outside, relative(join(scratch, "data"), outside)]) {
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
  writeFileSync(join(scratch, "data/editable.pth"), `# comment\n\nimport sys; sys.path.append('/outside')\nimport\tsite\n.\n${scratch}\n`);
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
  const pth = join(scratch, "data/editable.pth");
  writeFileSync(pth, `${alias}\n`);
  const result = run(scratch);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(outside), result.stderr);
});

test("scratch containment permits editable metadata targeting a locked system file", {
  skip: !existsSync("/usr/bin/python3") || process.getuid?.() === 0,
}, (t) => {
  const { scratch } = fixture(t);
  writeFileSync(join(scratch, "data/system.pth"), "/usr/bin/python3\n");
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
    const link = join(scratch, "data", name);
    symlinkSync("metadata", link);
    const result = run(scratch);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(link), result.stderr);
    assert.ok(result.stderr.includes(outside), result.stderr);
    rmSync(link);
  }
});
