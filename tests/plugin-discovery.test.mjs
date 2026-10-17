import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifest, verifyDiscovery, project, run } from "../scripts/lib/skill-evidence.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "supermatt-package-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (name, body) => {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), body);
  };
  file("skills/example/SKILL.md", "---\nname: example\ndisable-model-invocation: true\n---\nRead GUIDE.md.\n");
  file("skills/example/agents/openai.yaml", "policy:\n  allow_implicit_invocation: false\n");
  file("skills/example/GUIDE.md", "Reference bytes\n");
  file("references/shared.md", "Shared bytes\n");
  file(".claude-plugin/plugin.json", '{"name":"supermatt","version":"1.0.0"}');
  file(".agents/plugins/marketplace.json", '{"name":"supermatt","plugins":[{"name":"supermatt"}]}');
  file(".cursor-plugin/plugin.json", '{"name":"supermatt"}');
  return { root, file };
}

function discovered(root) {
  return { data: [{ errors: [], skills: [{ name: "supermatt:example", pluginId: "supermatt@supermatt",
    enabled: true, path: join(root, "skills/example/SKILL.md"), policy: { allowImplicitInvocation: false } }] }] };
}

test("discovery checks exact inventory, invocation policy and all resource bytes", t => {
  const { root, file } = fixture(t);
  const expected = manifest(root);
  assert.deepEqual(expected.packages, { claude: "supermatt", codex: "supermatt", cursor: "supermatt" });
  assert.equal(verifyDiscovery(discovered(root), expected, root).skills, 1);
  const missing = discovered(root); missing.data[0].skills = [];
  assert.throws(() => verifyDiscovery(missing, expected, root), /inventory/);
  const disabled = discovered(root); disabled.data[0].skills[0].enabled = false;
  assert.throws(() => verifyDiscovery(disabled, expected, root), /disabled/);
  const policy = discovered(root); policy.data[0].skills[0].policy.allowImplicitInvocation = true;
  assert.throws(() => verifyDiscovery(policy, expected, root), /invocation/);
  const parser = discovered(root); parser.data[0].errors.push({ message: "bad YAML" });
  assert.throws(() => verifyDiscovery(parser, expected, root), /parser/);
  file("references/shared.md", "changed\n");
  assert.throws(() => verifyDiscovery(discovered(root), expected, root), /resource/);
});

test("packaging rejects metadata drift and escaping resources", t => {
  const { root, file } = fixture(t);
  file("skills/example/agents/openai.yaml", "policy:\n  allow_implicit_invocation: true\n");
  assert.throws(() => manifest(root), /invocation/);
  file("skills/example/agents/openai.yaml", "policy:\n  allow_implicit_invocation: false\n");
  symlinkSync("/etc/hosts", join(root, "skills/example/outside"));
  assert.throws(() => manifest(root), /symlink/);
  rmSync(join(root, "skills/example/outside"));
  file(".cursor-plugin/plugin.json", '{"name":"supermatt","version":"1.0.0"}');
  assert.throws(() => manifest(root), /must use the Claude manifest version/);
});

test("release projection omits only dev directories and survives source removal", t => {
  const { root, file } = fixture(t);
  file("scripts/dev.mjs", "dev"); file("tests/test.mjs", "test"); file(".github/workflows/ci.yml", "ci");
  const destination = mkdtempSync(join(tmpdir(), "supermatt-projection-"));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  project(root, destination);
  const expected = manifest(destination);
  assert.ok(!Object.keys(expected.files).some(p => /^(scripts|tests|\.github)\//.test(p)));
  rmSync(root, { recursive: true });
  assert.equal(verifyDiscovery(discovered(destination), expected, destination).skills, 1);
});

test("process failures and timeouts cannot pass", async () => {
  await assert.rejects(run(process.execPath, ["-e", "process.exit(7)"]), /exit 7/);
  await assert.rejects(run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 50 }), /timed out/);
  await assert.rejects(run(process.execPath, ["-e", "console.log('x'.repeat(10000))"], { maxBytes: 100 }), /output limit/);
});
