import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("commit-msg hook rejects an unaccepted type and names every type its regex accepts", (t) => {
  // Keep the fixture path free of spaces and quotes because the configured {1} is unquoted.
  const dir = mkdtempSync(join(tmpdir(), "commit-msg-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const message = join(dir, "COMMIT_EDITMSG");
  writeFileSync(message, "test(retro): example\n");

  const script = commitMsgScript();
  const accepted = script.match(/grep -qE '\^\(([^)]+)\)/);
  assert.ok(accepted, `no type alternation in the commit-msg regex:\n${script}`);
  const result = spawnSync("sh", ["-c", script.replaceAll("{1}", message)], { encoding: "utf8" });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  const named = result.stdout.match(/Accepted types: ([^.]+)\./);
  assert.ok(named, `rejection does not name the accepted types:\n${result.stdout}`);
  assert.deepEqual(named[1].split(/,\s*/).sort(), accepted[1].split("|").sort());
});
