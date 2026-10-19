#!/usr/bin/env node
// Protects and later verifies the source files of a QA scratch copy.
//
// prepare <repo> <scratch> <dir>: lists the repository's tracked and untracked
// (not ignored) paths, classifies each by what the copy actually holds, and
// write-protects only regular files inside the copy, including a file listed
// under a symlinked directory that resolves inside the copy, which it protects
// at its real path so chmod traverses no link. A listed path that is absent
// from the working tree (an uncommitted deletion) goes to <dir>/deleted.lst;
// every present path goes to <dir>/sources.lst. It first removes both lists
// from any earlier run, so a preparation that stops leaves none behind. A listed
// symlink, or a path under a symlinked directory, that resolves outside the copy
// is rejected before any file is touched or any list is written, since following
// it would act on files outside the copy.
//
// verify <repo> <scratch> <dir>: compares each path in sources.lst between the
// repository and the copy (type, executable bits, file bytes, link target) and
// confirms each path in deleted.lst is still absent. Prints one line per difference;
// an entry it cannot read on either side is a difference too.
//
// Both lists are NUL-delimited. Exit 0 on success, 1 on a rejected link or a
// difference, 2 on usage or setup errors (a repository git cannot list, or a
// manifest verify cannot read).
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const readList = (name) => {
  try {
    return readFileSync(join(dir, name), "utf8").split("\0").filter(Boolean);
  } catch (error) {
    console.error(`Cannot read ${join(dir, name)} (${error.code}): run prepare before verify`);
    process.exit(2);
  }
};
const writeList = (name, paths) => writeFileSync(join(dir, name), paths.map((path) => `${path}\0`).join(""));

if (mode === "prepare") {
  // An earlier run's lists must not survive a preparation that stops below.
  for (const name of ["sources.lst", "deleted.lst"]) rmSync(join(dir, name), { force: true });
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
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = realOrLexical(dirname(path));
      const candidate = join(parent, basename(path));
      return lstatOrNull(candidate)?.isSymbolicLink()
        ? realOrLexical(resolve(parent, readlinkSync(candidate)))
        : candidate;
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
      // The parent is fully resolved inside the copy and the last component is no link,
      // so chmod on the real path reaches this in-copy file without traversing any link.
      if (stat.isFile()) protect.push(join(parent, basename(copied)));
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
  const kind = (stat) => (stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other");
  const compare = (path) => {
    const original = lstatOrNull(join(repo, path));
    const copied = lstatOrNull(join(scratch, path));
    if (!original || !copied) return `missing ${path} (${original ? "copy" : "repository"})`;
    if (kind(original) !== kind(copied)) return `changed ${path} (${kind(original)} became ${kind(copied)})`;
    if (original.isSymbolicLink() && readlinkSync(join(repo, path)) !== readlinkSync(join(scratch, path))) return `changed ${path} (link target)`;
    if (original.isFile() && (original.mode & 0o111) !== (copied.mode & 0o111)) return `changed ${path} (executable bits)`;
    if (original.isFile() && !readFileSync(join(repo, path)).equals(readFileSync(join(scratch, path)))) return `changed ${path} (content)`;
    return null;
  };
  const check = (path, difference) => {
    let line;
    try {
      line = difference(path);
    } catch (error) {
      line = `unreadable ${path} (${error.code ?? error.message})`;
    }
    if (line) {
      differences += 1;
      console.log(line);
    }
  };
  for (const path of readList("sources.lst")) check(path, compare);
  for (const path of readList("deleted.lst")) check(path, (path) => (lstatOrNull(join(scratch, path)) ? `recreated ${path}` : null));
  process.exitCode = differences > 0 ? 1 : 0;
}
