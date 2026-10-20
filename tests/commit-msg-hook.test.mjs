import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const config = readFileSync(fileURLToPath(new URL("../lefthook.yml", import.meta.url)), "utf8");

// The block scalar under `run: |` in the commit-msg job, dedented, exactly as lefthook hands it to sh.
function commitMsgScript() {
  const lines = config.split("\n");
  const start = lines.indexOf("commit-msg:");
  assert.notEqual(start, -1, "lefthook.yml has no commit-msg section");
  const runLine = lines.findIndex((line, i) => i > start && /^\s+run: \|$/.test(line));
  assert.notEqual(runLine, -1, "commit-msg job has no block run script");
  const keyIndent = lines[runLine].search(/\S/);
  const body = [];
  for (const line of lines.slice(runLine + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((line) => line.trim()).map((line) => line.search(/\S/)));
  return body.map((line) => line.slice(indent)).join("\n");
}

// Writes `subject` to `relativePath` under a fresh temp dir and runs the hook on it, substituting
// {1} verbatim the way lefthook does. Returns the run and the message bytes left afterwards.
function runHook(t, relativePath, subject) {
  const dir = mkdtempSync(join(tmpdir(), "commit-msg-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const message = join(dir, relativePath);
  mkdirSync(dirname(message), { recursive: true });
  writeFileSync(message, `${subject}\n`);
  const result = spawnSync("sh", ["-c", commitMsgScript().replaceAll("{1}", message)], { encoding: "utf8" });
  return { result, left: readFileSync(message, "utf8") };
}

const awkwardPaths = [
  "message with spaces.txt",
  "dir with space/m.txt",
  "it's.txt",
  "it's dir/m.txt",
  'say "hi".txt',
  "$HOME dir/$1.txt",
  "tick `false` dir/`id`.txt",
  "back\\slash.txt",
  " edge spaces /m.txt ",
];

for (const path of awkwardPaths) {
  test(`commit-msg hook accepts a valid subject in ${JSON.stringify(path)}`, (t) => {
    const { result, left } = runHook(t, path, "fix: path");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(left, "fix: path\n");
  });

  test(`commit-msg hook rejects an invalid subject in ${JSON.stringify(path)} with the accepted types`, (t) => {
    const { result, left } = runHook(t, path, "test: path");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Accepted types: /);
    assert.equal(result.stderr, "");
    assert.equal(left, "test: path\n");
  });
}

test("commit-msg hook rejects an unaccepted type and names every type its regex accepts", (t) => {
  const accepted = commitMsgScript().match(/grep -qE '\^\(([^)]+)\)/);
  assert.ok(accepted, `no type alternation in the commit-msg regex:\n${commitMsgScript()}`);
  const { result } = runHook(t, "COMMIT_EDITMSG", "test(retro): example");

  assert.equal(result.status, 1, result.stdout + result.stderr);
  const named = result.stdout.match(/Accepted types: ([^.]+)\./);
  assert.ok(named, `rejection does not name the accepted types:\n${result.stdout}`);
  assert.deepEqual(named[1].split(/,\s*/).sort(), accepted[1].split("|").sort());
});
