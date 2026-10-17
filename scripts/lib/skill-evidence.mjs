import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
export const inside = (root, path) => path === root || path.startsWith(root + sep);

export function files(root, prefix = "") {
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    const path = join(prefix, name);
    const stat = lstatSync(join(root, path));
    assert.ok(!stat.isSymbolicLink(), `Unsupported symlink in artifact: ${path}`);
    if (stat.isDirectory()) return files(root, path);
    assert.ok(stat.isFile(), `Unsupported resource: ${path}`);
    return [path];
  });
}

// Each file's digest, by path.
const inventory = (root, entries = files(root)) => Object.fromEntries(entries.map(path => [path, digest(readFileSync(join(root, path)))]));

export function verifyPackages(root) {
  const claude = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  const codex = JSON.parse(readFileSync(join(root, ".agents/plugins/marketplace.json"), "utf8"));
  const cursor = JSON.parse(readFileSync(join(root, ".cursor-plugin/plugin.json"), "utf8"));
  assert.equal(claude.name, "supermatt", "Claude package name mismatch");
  assert.equal(codex.name, "supermatt", "Codex marketplace name mismatch");
  assert.deepEqual(codex.plugins.map(plugin => plugin.name), ["supermatt"], "Codex plugin name mismatch");
  assert.equal(cursor.name, "supermatt", "Cursor package name mismatch");
  assert.ok(!("version" in cursor), "Cursor package must use the Claude manifest version");
  assert.ok(!("skills" in cursor), "Cursor package must discover the root skills/ directory");
  return { claude: claude.name, codex: codex.name, cursor: cursor.name };
}

// `packaging: false` skips the package manifest checks, for a snapshot that is only measured
// and never shipped: an older baseline can predate a manifest the current release requires.
export function manifest(root, { packaging = true } = {}) {
  const packages = packaging ? verifyPackages(root) : null;
  const entries = files(root);
  const skills = entries.filter(p => /^skills\/[^/]+\/SKILL\.md$/.test(p)).map(path => {
    const body = readFileSync(join(root, path), "utf8");
    const name = path.split("/")[1];
    assert.match(body, new RegExp(`^name: ${name}$`, "m"), `Skill name mismatch: ${path}`);
    const implicit = !/^disable-model-invocation: true$/m.test(body);
    const metadata = readFileSync(join(root, dirname(path), "agents/openai.yaml"), "utf8");
    const policy = metadata.match(/^\s*allow_implicit_invocation:\s*(true|false)\s*$/m);
    assert.equal(policy ? policy[1] === "true" : true, implicit, `invocation mismatch: ${name}`);
    return { name, path, implicit };
  });
  assert.ok(skills.length, "Empty skill inventory");
  assert.equal(entries.filter(p => p.endsWith("/SKILL.md")).length, skills.length, "Nested skills are not supported");
  const resources = inventory(root, entries);
  return { skills, packages, files: resources, digest: digest(JSON.stringify(resources)) };
}

// Keep this exclusion list paired with scripts/directory-branch.sh; its existing
// release tests and the projection test protect the published tree shape.
export function project(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    if ([".git", "scripts", "tests", ".github"].includes(name)) continue;
    cpSync(join(source, name), join(destination, name), { recursive: true, dereference: false });
  }
}

export async function snapshot(repo, revision, destination) {
  mkdirSync(destination, { recursive: true });
  if (revision !== "working") {
    const archive = await run("git", ["-C", repo, "archive", "--format=tar", revision], { binary: true });
    await run("tar", ["-xf", "-", "-C", destination], { input: archive });
  } else {
    const paths = (await run("git", ["-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
      .split("\0").filter(Boolean);
    for (const path of new Set(paths)) {
      if (!existsSync(join(repo, path))) continue;
      mkdirSync(dirname(join(destination, path)), { recursive: true });
      cpSync(join(repo, path), join(destination, path), { dereference: false });
    }
  }
}

export function run(command, args, { timeout = 60000, input, binary = false, maxBytes = 64 * 1024 * 1024, ...options } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { ...options, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    let timedOut = false, exceeded = false, interrupted = false, bytes = 0;
    const kill = signal => {
      try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch {}
    };
    const interrupt = () => { interrupted = true; kill("SIGKILL"); };
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    const cleanup = () => { clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); };
    const timer = setTimeout(() => { timedOut = true; kill("SIGKILL"); }, timeout);
    const capture = target => chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { exceeded = true; kill("SIGKILL"); }
      else target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.stdin.on("error", () => {});
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      cleanup();
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr).toString();
      if (code !== 0 || timedOut || exceeded || interrupted) {
        const reason = timedOut ? "timed out" : exceeded ? "output limit exceeded" : interrupted ? "interrupted" : `exit ${code}`;
        const error = new Error(`${command}: ${reason}\n${err}`);
        Object.assign(error, { stdout: out.toString(), stderr: err, code, timedOut });
        reject(error);
      } else resolveResult(binary ? out : out.toString());
    });
    child.stdin.end(input);
  });
}

export function privateEnvironment(home) {
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(join(home, "tmp"), { recursive: true });
  return { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: join(home, "tmp"),
    LANG: "C.UTF-8", XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") };
}

export async function installPlugin(codex, source, options) {
  await run(codex, ["plugin", "marketplace", "add", source, "--json"], options);
  return JSON.parse(await run(codex, ["plugin", "add", "supermatt@supermatt", "--json"], options));
}

export async function listSkills(codex, options, includeConfiguration = false) {
  const child = spawn(codex, ["app-server", "--stdio"], { ...options, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 0, buffer = "", stderr = "";
  const fail = error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line), waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
          else waiter.resolve(message.result);
        }
      } catch (error) { fail(error); }
    }
  });
  child.on("error", fail);
  child.on("exit", code => fail(new Error(`Codex discovery exited ${code}: ${stderr}`)));
  child.stdin.on("error", fail);
  const timer = setTimeout(() => { fail(new Error("Codex discovery timed out")); child.kill("SIGKILL"); }, 45000);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: "supermatt-discovery", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const skills = await request("skills/list", { cwds: [options.cwd], forceReload: true });
    if (includeConfiguration) {
      const { config } = await request("config/read", { cwd: options.cwd, includeLayers: false });
      assert.ok(config && typeof config === "object", "Native configuration unavailable");
      // Persist only capability switches, never server credentials or env maps.
      skills.configuration = { mcpServers: Object.entries(config.mcp_servers ?? {}).filter(([, value]) => value.enabled !== false).map(([name]) => name),
        webSearch: config.web_search, defaultPermissions: config.default_permissions, features: config.features };
    }
    return skills;
  } finally { clearTimeout(timer); child.kill(); }
}

export function verifyDiscovery(observed, expected, home) {
  assert.equal(observed.data.length, 1, "Expected one discovery root");
  const entry = observed.data[0];
  assert.deepEqual(entry.errors, [], "Native parser errors");
  const native = entry.skills.filter(skill => skill.pluginId === "supermatt@supermatt");
  assert.deepEqual(native.map(s => s.name).sort(), expected.skills.map(s => `supermatt:${s.name}`).sort(), "Skill inventory mismatch");
  let root;
  for (const skill of native) {
    assert.equal(skill.enabled, true, `Skill disabled: ${skill.name}`);
    const source = expected.skills.find(s => `supermatt:${s.name}` === skill.name);
    // Current Codex skills/list omits policy. Installed metadata bytes are still
    // checked below; absence is not evidence of runtime invocation enforcement.
    if (skill.policy?.allowImplicitInvocation !== undefined) {
      assert.equal(skill.policy.allowImplicitInvocation, source.implicit, `Native invocation mismatch: ${skill.name}`);
    }
    const installed = realpathSync(skill.path);
    assert.ok(inside(realpathSync(home), installed), "Skill escaped isolated home");
    const candidate = resolve(dirname(installed), "../..");
    assert.ok(!root || root === candidate, "Skills resolved to different packages");
    root = candidate;
    assert.equal(relative(root, installed), source.path);
  }
  // Equal bytes carry every check manifest() ran on the frozen carrier for this arm.
  assert.deepEqual(inventory(root), expected.files, "Installed resource inventory or bytes differ");
  return { skills: native.length, resources: Object.keys(expected.files).length, root,
    invocationMetadata: "pass", runtimeInvocationPolicy: "unobserved" };
}
