#!/usr/bin/env node
// Protects and later verifies the source files of a QA scratch copy.
//
// prepare <repo> <scratch> <dir>: lists the repository's tracked and untracked
// (not ignored) paths, classifies each by what the copy actually holds, and
// write-protects only regular files whose path stays inside the copy. A listed
// path that is absent from the working tree (an uncommitted deletion) goes to
// <dir>/deleted.lst; every present path goes to <dir>/sources.lst. A listed
// symlink, or a path under a symlinked directory, that resolves outside the copy
// is rejected before any file is touched, since following it would act on files
// outside the copy.
//
// verify <repo> <scratch> <dir>: compares each path in sources.lst between the
// repository and the copy (type, file bytes, link target) and confirms each path
// in deleted.lst is still absent from the copy. Prints one line per difference.
//
// Both lists are NUL-delimited. Exit 0 on success, 1 on a rejected link or a
// difference, 2 on usage or setup errors.
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const [mode, repo, scratch, dir] = process.argv.slice(2);
if (!["prepare", "verify"].includes(mode) || !repo || !scratch || !dir) {
  console.error("Usage: scratch-sources.mjs prepare|verify <repo> <scratch> <dir>");
  process.exit(2);
}

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
};
const readList = (name) => readFileSync(join(dir, name), "utf8").split("\0").filter(Boolean);
const writeList = (name, paths) => writeFileSync(join(dir, name), paths.map((path) => `${path}\0`).join(""));

if (mode === "prepare") {
  const listed = spawnSync("git", ["-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (listed.status !== 0) {
    console.error(`git ls-files failed in ${repo}: ${listed.stderr.trim()}`);
    process.exit(2);
  }
  const root = realpathSync(scratch);
  const inside = (path) => path === root || path.startsWith(root + sep);
  // Resolves a path lexically from its real parent, following every symlink
  // that exists; a dangling final link resolves to where it points.
  const realOrLexical = (path) => {
    try {
      return realpathSync(path);
    } catch {
      const parent = dirname(path);
      return parent === path ? path : join(realOrLexical(parent), basename(path));
    }
  };

  const paths = [...new Set(listed.stdout.split("\0").filter(Boolean))];
  const sources = [];
  const deleted = [];
  const protect = [];
  const escaping = [];
  for (const path of paths) {
    const copied = join(root, path);
    const parent = realOrLexical(dirname(copied));
    const stat = lstatOrNull(copied);
    if (!inside(parent)) {
      escaping.push(`${path} (under a link to ${parent})`);
    } else if (!stat) {
      deleted.push(path);
    } else if (stat.isSymbolicLink()) {
      const target = realOrLexical(resolve(parent, readlinkSync(copied)));
      if (inside(target)) sources.push(path);
      else escaping.push(`${path} -> ${target}`);
    } else {
      sources.push(path);
      // A regular file whose parent is a real directory of the copy: chmod acts on this file only.
      if (stat.isFile() && parent === dirname(copied)) protect.push(copied);
    }
  }
  if (escaping.length > 0) {
    console.error(`Listed links resolve outside ${root}; nothing was protected:`);
    for (const line of escaping) console.error(`  ${line}`);
    process.exit(1);
  }
  for (const path of protect) chmodSync(path, lstatSync(path).mode & 0o7555);
  writeList("sources.lst", sources);
  writeList("deleted.lst", deleted);
  console.log(`${protect.length} files protected, ${sources.length} sources listed, ${deleted.length} deletions listed`);
} else {
  let differences = 0;
  const report = (line) => {
    differences += 1;
    console.log(line);
  };
  const kind = (stat) => (stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other");
  for (const path of readList("sources.lst")) {
    const original = lstatOrNull(join(repo, path));
    const copied = lstatOrNull(join(scratch, path));
    if (!original || !copied) {
      report(`missing ${path} (${original ? "copy" : "repository"})`);
    } else if (kind(original) !== kind(copied)) {
      report(`changed ${path} (${kind(original)} became ${kind(copied)})`);
    } else if (original.isSymbolicLink() && readlinkSync(join(repo, path)) !== readlinkSync(join(scratch, path))) {
      report(`changed ${path} (link target)`);
    } else if (original.isFile() && !readFileSync(join(repo, path)).equals(readFileSync(join(scratch, path)))) {
      report(`changed ${path} (content)`);
    }
  }
  for (const path of readList("deleted.lst")) {
    if (lstatOrNull(join(scratch, path))) report(`recreated ${path}`);
  }
  process.exitCode = differences > 0 ? 1 : 0;
}
