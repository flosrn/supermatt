#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { join, relative, resolve } from "node:path";

// Workspace member manifests under root, excluding root's own: never enters
// node_modules or a symlinked directory, and skips unreadable entries.
function memberManifests(root) {
  const manifests = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules") pending.push(join(current, entry.name));
      if (current === root || !entry.isFile() || entry.name !== "package.json") continue;
      try {
        const manifest = JSON.parse(readFileSync(join(current, entry.name), "utf8"));
        manifests.push({ path: relative(root, current), directory: current, manifest });
      } catch {}
    }
  }
  return manifests.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function declares(manifest, name) {
  return [manifest?.dependencies, manifest?.devDependencies].some((field) => field !== null && typeof field === "object" && Object.hasOwn(field, name));
}

const [directory, ...packages] = process.argv.slice(2);
if (!directory || packages.length === 0) {
  console.error("Usage: check-scratch-dependencies.mjs <directory> <required-package>...");
  process.exitCode = 2;
} else {
  const root = resolve(directory);
  const requireFromScratch = createRequire(resolve(root, "package.json"));
  let members;
  for (const name of packages) {
    if (isBuiltin(name)) {
      console.log(`${name}: built-in`);
      continue;
    }
    try {
      console.log(`${name}: ${realpathSync(requireFromScratch.resolve(name))}`);
    } catch (error) {
      console.error(`Cannot resolve ${name} from ${root}: ${error.message}`);
      members ??= memberManifests(root);
      for (const member of members) {
        if (declares(member.manifest, name)) console.error(`${name} is declared by \`${member.path}\`: rerun with \`${member.directory}\``);
      }
      process.exitCode = 1;
    }
  }
}
