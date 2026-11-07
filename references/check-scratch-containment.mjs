#!/usr/bin/env node
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalHome, canonicalPath, lockedSystemEntry, lockedSystemFile, outside, scriptInterpreter } from "./scratch-paths.mjs";

function linkTarget(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`dangling link (target missing in scratch): ${path} -> ${readlinkSync(path)}`);
    throw error;
  }
}

function entries(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
}

// Python's site module adds a top-level .pth file's path lines to sys.path, resolved against site-packages.
// Its comment, blank, and import lines resolve inside site-packages here, so they need no exception.
function checkPathFiles(venv, root) {
  for (const lib of entries(join(venv, "lib")).filter((entry) => entry.isDirectory())) {
    const sitePackages = join(venv, "lib", lib.name, "site-packages");
    for (const entry of entries(sitePackages).filter((item) => item.isFile() && item.name.endsWith(".pth"))) {
      const file = join(sitePackages, entry.name);
      for (const line of readFileSync(file, "utf8").split(/\r\n|\r|\n/)) {
        const path = resolve(sitePackages, line);
        if (outside(root, canonicalPath(path))) throw new Error(`.pth path points outside scratch: ${file} -> ${path}`);
      }
    }
  }
}

function head(file) {
  const buffer = Buffer.alloc(4096);
  const descriptor = openSync(file, "r");
  try {
    return buffer.toString("utf8", 0, readSync(descriptor, buffer, 0, buffer.length, 0));
  } finally {
    closeSync(descriptor);
  }
}

// A script in bin/ runs the environment its interpreter path belongs to, which the path's directory decides,
// so the path counts as inside scratch by its canonical directory, not by where its links end.
function checkScripts(venv, root, home) {
  for (const entry of entries(join(venv, "bin")).filter((item) => item.isFile())) {
    const file = join(venv, "bin", entry.name);
    const interpreter = scriptInterpreter(head(file));
    if (!interpreter || !isAbsolute(interpreter)) continue;
    const location = join(canonicalPath(dirname(interpreter)), basename(interpreter));
    if (outside(root, location) && !lockedSystemEntry(interpreter, home)) {
      throw new Error(`shebang points outside scratch: ${file} -> ${interpreter}`);
    }
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
        // A .git file or link (a linked worktree's gitdir pointer) sends Git commands in scratch to another
        // repository, so a commit there lands on its branch; only a directory, such as git init makes, stays inside.
        if (entry.name === ".git" && !entry.isDirectory()) {
          throw new Error(`.git is not a directory: ${path}`);
        } else if (entry.isSymbolicLink()) {
          const target = linkTarget(path);
          if (outside(root, target) && !lockedSystemFile(target, home)) {
            throw new Error(`symlink escapes scratch: ${path} -> ${target}`);
          }
        } else if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.name === "pyvenv.cfg" && entry.isFile()) {
          checkScripts(current, root, home);
          checkPathFiles(current, root);
        }
      }
    }
    console.log(`Scratch containment verified: ${root}`);
  } catch (error) {
    console.error(`Unsafe scratch tree ${resolve(directory)}: ${error.message}`);
    process.exitCode = 1;
  }
}
