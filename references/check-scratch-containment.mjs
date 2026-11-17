#!/usr/bin/env node
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const SITE_DIRECTORIES = ["site-packages", "dist-packages"];

// Python's site module splits a .pth file in a site directory with str.splitlines, skips it unless it is a
// regular file, and adds each path line to sys.path resolved against the site directory as it was named.
function checkPathFile(file, site, root, home) {
  if (!statSync(file).isFile()) return;
  for (const line of readFileSync(file, "utf8").split(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/)) {
    const value = line.trim();
    if (!value || value.startsWith("#") || /^import[ \t]/.test(value)) continue;
    const target = canonicalTarget(resolve(site, value));
    if (outside(root, target) && !allowedSystemTarget(target, home)) {
      throw new Error(`.pth path escapes scratch: ${file} -> ${target}; if the trigger needs no Python, remove the copied virtualenv containing this entry; otherwise rebuild the environment inside scratch and force-reinstall the editable package from the scratch copy. Rerun the containment check.`);
    }
  }
}

// Checks the .pth files of a site directory reached through a link, which the walk does not enter, under the
// name Python uses for it. A site directory whose canonical path leaves scratch is left to the walk, which
// rejects the link, and each .pth link is checked before its content is read.
function checkSite(site, root, home) {
  try {
    if (outside(root, realpathSync(site)) || !statSync(site).isDirectory()) return;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
    throw error;
  }
  for (const entry of entries(site).filter((item) => (item.isFile() || item.isSymbolicLink()) && item.name.endsWith(".pth"))) {
    const file = join(site, entry.name);
    if (entry.isSymbolicLink()) {
      const target = linkTarget(file);
      if (outside(root, target) && !lockedSystemFile(target, home)) throw new Error(`symlink escapes scratch: ${file} -> ${target}`);
    }
    checkPathFile(file, site, root, home);
  }
}

// A virtualenv's site directories are <venv>/lib/pythonX.Y/site-packages (or dist-packages), named that way even
// where lib or a directory below it is a link.
function checkVirtualenvSites(venv, root, home) {
  for (const version of entries(join(venv, "lib"))) {
    for (const name of SITE_DIRECTORIES) checkSite(join(venv, "lib", version.name, name), root, home);
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
          if (SITE_DIRECTORIES.includes(entry.name)) checkSite(path, root, home);
        } else if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.name === "pyvenv.cfg" && entry.isFile()) {
          checkScripts(current, root, home);
          checkVirtualenvSites(current, root, home);
        }
        if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".pth") && SITE_DIRECTORIES.includes(basename(current))) {
          checkPathFile(path, current, root, home);
        }
        if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === "direct_url.json") {
          const record = JSON.parse(readFileSync(path, "utf8"));
          // An archive install (a wheel or sdist) copied its files into site-packages, so its URL is provenance
          // only. Any other record, such as a directory install, editable or not, keeps its URL checked, and a
          // record that names dir_info or vcs_info at all is not treated as an archive.
          const archive = typeof record.archive_info === "object" && record.archive_info !== null;
          if (archive && !("dir_info" in record) && !("vcs_info" in record)) continue;
          const { url } = record;
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
