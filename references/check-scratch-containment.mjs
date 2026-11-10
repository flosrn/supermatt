#!/usr/bin/env node
import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function outside(base, path) {
  const offset = relative(base, path);
  return isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`);
}

// A link may leave scratch only for a system file the user cannot change: a non-directory owned by root,
// not writable by the user, and outside the user's home, such as a virtualenv's interpreter link.
function lockedSystemFile(path, home) {
  try {
    accessSync(path, constants.W_OK);
    return false;
  } catch {
    const stats = statSync(path);
    return stats.uid === 0 && !stats.isDirectory() && outside(home, path);
  }
}

function canonicalHome() {
  try {
    return realpathSync(homedir());
  } catch {
    return resolve(homedir());
  }
}

function canonicalTarget(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalTarget(parent), basename(path));
  }
}

function allowedSystemTarget(path, home) {
  try {
    return lockedSystemFile(path, home);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length) {
  console.error("Usage: check-scratch-containment.mjs <scratch-directory>");
  process.exitCode = 2;
} else {
  try {
    if (lstatSync(resolve(directory)).isSymbolicLink()) throw new Error("scratch root is a symlink");
    const root = realpathSync(directory);
    const home = canonicalHome();
    const pending = [root];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) {
          const target = realpathSync(path);
          if (outside(root, target) && !lockedSystemFile(target, home)) {
            throw new Error(`symlink escapes scratch: ${path} -> ${target}`);
          }
        } else if (entry.isDirectory()) {
          pending.push(path);
        }
        if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".pth") &&
            ["site-packages", "dist-packages"].includes(basename(current))) {
          for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
            const value = line.trim();
            if (!value || value.startsWith("#") || /^import[ \t]/.test(value)) continue;
            const target = canonicalTarget(resolve(current, value));
            if (outside(root, target) && !allowedSystemTarget(target, home)) {
              throw new Error(`.pth path escapes scratch: ${path} -> ${target}`);
            }
          }
        }
        if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === "direct_url.json") {
          const { url } = JSON.parse(readFileSync(path, "utf8"));
          if (typeof url === "string" && url.startsWith("file:")) {
            const target = canonicalTarget(fileURLToPath(url));
            if (outside(root, target) && !allowedSystemTarget(target, home)) {
              throw new Error(`direct_url.json path escapes scratch: ${path} -> ${target}`);
            }
          }
        }
      }
    }
    console.log(`Scratch containment verified: ${root}`);
  } catch (error) {
    console.error(`Unsafe scratch tree ${resolve(directory)}: ${error.message}`);
    process.exitCode = 1;
  }
}
