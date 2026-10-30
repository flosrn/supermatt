#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function removeTree(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, stat.mode | 0o700);
    for (const entry of readdirSync(path)) removeTree(join(path, entry));
  }
  rmSync(path, { recursive: stat.isDirectory(), force: true });
}

function prune(directory, source) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.name === ".git" || (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink())) {
      const { mode, atime, mtime } = lstatSync(directory);
      try {
        chmodSync(directory, mode | 0o700);
        removeTree(path);
      } finally {
        chmodSync(directory, mode);
        utimesSync(directory, atime, mtime);
      }
    } else if (entry.isDirectory()) prune(path, join(source, entry.name));
    else if (entry.isFile() && process.platform === "darwin") {
      // clonefile clears setuid/setgid; the scratch copy keeps rsync's file modes.
      const mode = lstatSync(join(source, entry.name)).mode & 0o7777;
      if (mode & 0o6000) chmodSync(path, mode);
    }
  }
  if (process.platform === "darwin") {
    const mode = lstatSync(source).mode & 0o7777;
    if (mode & 0o6000) chmodSync(directory, mode);
  }
}

const macClone = `import ctypes, os, sys
library = ctypes.CDLL(None, use_errno=True)
clone = library.clonefile
clone.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
clone.restype = ctypes.c_int
result = clone(os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), 1)
sys.exit(ctypes.get_errno() if result else 0)
`;

const [source, target, ...extra] = process.argv.slice(2);
if (!source || !target || extra.length) {
  console.error("Usage: copy-scratch-tree.mjs <repository> <new-scratch-directory>");
  process.exitCode = 2;
} else {
  try {
    if (!lstatSync(resolve(source)).isDirectory()) throw new Error("repository must be a directory, not a symlink");
    const root = realpathSync(source);
    const destination = join(realpathSync(dirname(resolve(target))), basename(resolve(target)));
    const offset = relative(root, destination);
    if (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`)) {
      throw new Error("scratch destination must be outside the repository");
    }
    try {
      lstatSync(destination);
      throw new Error("scratch destination already exists");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    let method = process.platform === "darwin" ? "clonefile" : "cp --reflink=always";
    try {
      const clone = process.platform === "darwin"
        ? spawnSync("python3", ["-I", "-c", macClone, root, destination], { encoding: "utf8" })
        : spawnSync("cp", ["-RpP", "--reflink=always", "--", `${root}${sep}.`, destination], { encoding: "utf8" });
      if (clone.error || clone.status !== 0) throw new Error("clone unavailable");
      prune(destination, root);
    } catch {
      try { removeTree(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const fallback = spawnSync("rsync", ["-a", "--no-specials", "--no-devices", "--exclude", ".git", "--", `${root}${sep}`, `${destination}${sep}`], { encoding: "utf8" });
      if (fallback.error || fallback.status !== 0) {
        try { removeTree(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
        throw new Error(fallback.error?.message || fallback.stderr.trim() || "rsync failed");
      }
      method = "rsync";
    }
    console.log(`Scratch tree copied with ${method}: ${destination}`);
  } catch (error) {
    console.error(`Scratch copy failed: ${error.message}`);
    process.exitCode = 1;
  }
}
