#!/usr/bin/env node
// A stand-in for the Codex CLI that never calls a model. It answers what
// scripts/evaluate-skills.mjs asks before its first model call: the version, the plugin
// install (a copy of the marketplace source into CODEX_HOME), the skill listing and
// configuration over app-server, and the sandbox preflight. Anything else fails.
const { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const installed = home && join(home, "plugins", "supermatt");

function skills() {
  const root = join(installed, "skills");
  return readdirSync(root).filter((name) => existsSync(join(root, name, "SKILL.md"))).map((name) => (
    { name: `supermatt:${name}`, pluginId: "supermatt@supermatt", enabled: true, path: join(root, name, "SKILL.md") }));
}

const results = {
  initialize: () => ({}),
  "skills/list": () => ({ data: [{ errors: [], skills: skills() }] }),
  "config/read": () => ({ config: { mcp_servers: {}, web_search: "disabled", default_permissions: "skill-eval",
    features: { apps: false, hooks: false, memories: false, multi_agent: false, browser_use: false, computer_use: false } } }),
};

const [command, verb] = args;
if (command === "--version") console.log("codex-stub 0.0.0");
else if (command === "plugin" && verb === "marketplace") {
  writeFileSync(join(home, "marketplace-source"), args[3]);
  console.log("{}");
} else if (command === "plugin" && verb === "add") {
  cpSync(readFileSync(join(home, "marketplace-source"), "utf8"), installed, { recursive: true });
  writeFileSync(join(home, "config.toml"), '[plugins."supermatt@supermatt"]\nenabled = true\n');
  console.log("{}");
} else if (command === "sandbox") console.log("isolation verified");
else if (command === "app-server") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const answer = results[message.method];
    process.stdout.write(JSON.stringify(answer ? { id: message.id, result: answer() } : { id: message.id, error: { message: `unexpected ${message.method}` } }) + "\n");
  });
} else {
  console.error(`unexpected codex ${args.join(" ")}`);
  process.exit(1);
}
