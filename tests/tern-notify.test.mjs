import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../skills/orchestrate/scripts/tern-notify.mjs", import.meta.url));

function commands(t, tern, ps) {
  const bin = mkdtempSync(join(tmpdir(), "tern-notify-test-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  for (const [name, source] of [["tern", tern], ["ps", ps]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${source}\n`, { mode: 0o755 });
  }
  return spawnSync(process.execPath, [script, "--pane", "123", "Test"], {
    env: { ...process.env, PATH: bin }, encoding: "utf8",
  });
}

test("notification discovery relays successful tern warnings before rejecting an invalid tty", (t) => {
  const result = commands(t, `printf 'tern warning\\n' >&2\nprintf '{"child":{"pid":456}}'`, "printf 'not-a-tty'");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "tern warning\ntern-notify: the shell of pane 123 has no terminal (not-a-tty)\n");
});

test("notification discovery relays successful ps warnings before rejecting an invalid tty", (t) => {
  const result = commands(t, `printf '{"child":{"pid":456}}'`, "printf 'ps warning\\n' >&2\nprintf 'not-a-tty'");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "ps warning\ntern-notify: the shell of pane 123 has no terminal (not-a-tty)\n");
});
