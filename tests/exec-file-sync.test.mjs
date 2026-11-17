import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const adapter = new URL("../references/exec-file-sync.mjs", import.meta.url).href;
// The helper ships for Node, so compare it with Node's own execFileSync even
// when Bun runs this file: Bun's errors carry extra source-location fields and
// lack the `error` self reference that Node's execFileSync error holds.
const node = process.versions.bun ? "node" : process.execPath;

function probe(implementation, child, options = {}, file = node) {
  return spawnSync(node, ["--input-type=module", "-e", `
    import { ${implementation === adapter ? "execFileSyncWithStderr as execFileSync" : "execFileSync"} } from ${JSON.stringify(implementation)};
    const normalize = value => Buffer.isBuffer(value) ? { buffer: [...value] } : Array.isArray(value) ? value.map(normalize) : value;
    try {
      const stdout = execFileSync(${JSON.stringify(file)}, ${JSON.stringify(child)}, ${JSON.stringify(options)});
      console.log(JSON.stringify({ stdout: normalize(stdout) }));
    } catch (error) {
      const fields = Object.fromEntries(Object.getOwnPropertyNames(error).filter(key => !["stack", "pid"].includes(key)).map(key => [key, error[key] === error ? { self: true } : normalize(error[key])]));
      console.log(JSON.stringify({ name: error.name, pidType: typeof error.pid, fields }));
    }
  `], { encoding: "utf8", timeout: 10_000 });
}

test("execFileSync relays successful child stderr and returns stdout unchanged", () => {
  const child = ["-e", "process.stdout.write('result'); process.stderr.write('warning\\n')"];
  const before = probe("node:child_process", child, { encoding: "utf8" });
  const after = probe(adapter, child, { encoding: "utf8" });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stderr, "warning\n");
  assert.deepEqual(JSON.parse(after.stdout), { stdout: "result" });
  assert.equal(after.stdout, before.stdout);
  assert.equal(after.stderr, before.stderr);
  assert.equal(after.status, before.status);
});

for (const [name, child, options, file] of [
  ["nonzero UTF-8 exit", ["-e", "process.stdout.write('partial'); process.stderr.write('failure\\n'); process.exit(7)"], { encoding: "utf8", argv0: "custom-node" }],
  ["nonzero Buffer exit", ["-e", "process.stdout.write(Buffer.from([0, 255])); process.stderr.write(Buffer.from([254, 10])); process.exit(9)"], {}],
  ["signal", ["-e", "process.stdout.write('partial'); process.stderr.write('signal\\n'); process.kill(process.pid, 'SIGTERM')"], { encoding: "utf8" }],
  ["missing executable", [], { encoding: "utf8" }, "/supermatt-test-no-such-executable"],
  ["timeout", ["-e", "process.stdout.write('partial'); process.stderr.write('timeout\\n'); setInterval(() => {}, 1000)"], { encoding: "utf8", timeout: 250, killSignal: "SIGKILL" }],
  ["maxBuffer", ["-e", "process.stderr.write('before overflow\\n'); process.stdout.write('x'.repeat(100000))"], { encoding: "utf8", maxBuffer: 100 }],
]) {
  test(`execFileSync preserves native ${name} diagnostics and error fields`, () => {
    const before = probe("node:child_process", child, options, file);
    const after = probe(adapter, child, options, file);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(before.status, 0, before.stderr);
    assert.deepEqual(JSON.parse(after.stdout), JSON.parse(before.stdout));
    assert.equal(after.stderr, before.stderr);
  });
}

test("execFileSync returns Buffer output with native stderr relay", () => {
  const child = ["-e", "process.stdout.write(Buffer.from([0, 255])); process.stderr.write(Buffer.from([254, 10]))"];
  const before = probe("node:child_process", child);
  const after = probe(adapter, child);
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(JSON.parse(after.stdout), { stdout: { buffer: [0, 255] } });
  assert.equal(after.stdout, before.stdout);
  assert.equal(after.stderr, before.stderr);
});

test("execFileSync child stdin is not a pipe", () => {
  const result = probe(adapter, ["-e", "const s=require('node:fs').fstatSync(0); console.log(JSON.stringify({socket:s.isSocket(),fifo:s.isFIFO(),character:s.isCharacterDevice()}))"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(JSON.parse(result.stdout).stdout);
  assert.deepEqual(child, { socket: false, fifo: false, character: true });
});
