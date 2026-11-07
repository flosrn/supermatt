#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, cpSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LAUNCHER, canonicalHome, lockedSystemFile, outside, shellWord } from "./scratch-paths.mjs";

// Each copied runtime lives inside its own virtualenv, which repositories already ignore.
const RUNTIMES = ".scratch-python";
const SHEBANG_LIMIT = 127;
const TEMPORARY = ".scratch-python-tmp";

function existing(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function removeTree(path) {
  const stats = existing(path);
  if (!stats) return;
  if (stats.isDirectory()) {
    chmodSync(path, stats.mode | 0o700);
    for (const entry of readdirSync(path)) removeTree(join(path, entry));
  }
  rmSync(path, { recursive: stats.isDirectory(), force: true });
}

// Directories holding pyvenv.cfg, found without following symlinked directories.
function virtualenvs(root) {
  const found = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    const venv = entries.some((entry) => entry.name === "pyvenv.cfg" && entry.isFile());
    if (venv) found.push(current);
    for (const entry of entries) {
      if (entry.isDirectory() && !(venv && entry.name === RUNTIMES)) pending.push(join(current, entry.name));
    }
  }
  return found.sort();
}

function regularFiles(venv) {
  const files = [];
  const pending = [venv];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isFile()) files.push(path);
      else if (entry.isDirectory() && !(current === venv && entry.name === RUNTIMES)) pending.push(path);
    }
  }
  return files.sort();
}

// Text is handled as latin1 so every byte round-trips unchanged, whatever the file's encoding.
const bytes = (text) => Buffer.from(text, "utf8").toString("latin1");
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`);
const PATH_CHARACTER = "[\\w.~+@%\\x80-\\xff-]";

// A file URL's path as Python's pathlib encodes it, keeping only letters, digits, and _.-~/, and as uv and
// Node encode it under the WHATWG URL rules, which keep more characters.
const pythonUrlPath = (path) => [...Buffer.from(path, "utf8")].map((byte) => (/[\w.~/-]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
const urlPaths = (path) => [pythonUrlPath(path), pathToFileURL(path).pathname];

// Replaces each repository path, as given or canonical, with the canonical scratch path, where it stands as a
// whole path or a path prefix: as text, it becomes the scratch path as text, and in a file URL in either
// encoding, such as in direct_url.json, the scratch path in Python's encoding, which every URL parser decodes
// the same way. Scratch paths already present as text stay as they are, so a scratch path that starts with the
// repository path is not rewritten again on a later run; in an encoded scratch path, the character after such a
// prefix is always % or a path character, which blocks the match.
function pathRewriter(repositoryPaths, scratchPaths, scratch) {
  const targets = new Map();
  for (const path of repositoryPaths) {
    for (const encoded of urlPaths(path)) targets.set(`file://${encoded}`, `file://${pythonUrlPath(scratch)}`);
    targets.set(bytes(path), bytes(scratch));
  }
  for (const path of scratchPaths) targets.set(bytes(path), bytes(path));
  const alternatives = [...targets.keys()].sort((left, right) => right.length - left.length).map(escapeRegExp);
  const pattern = new RegExp(`(?<!${PATH_CHARACTER})(?:${alternatives.join("|")})(?!${PATH_CHARACTER})`, "g");
  const needles = repositoryPaths.flatMap((path) => [Buffer.from(path, "utf8"), ...urlPaths(path).map((encoded) => Buffer.from(encoded))]);
  return {
    mentions: (buffer) => needles.some((needle) => buffer.includes(needle)),
    rewrite: (text) => text.replace(pattern, (match) => targets.get(match)),
  };
}

// Paths with these characters are refused, so a path never needs escaping in the files it is written into.
const UNWRITABLE = /['"\\\r\n]/;
const shellQuote = (path) => `'${path}'`;

// A launcher script gets its interpreter requoted. A rewritten #! line longer than the kernel reads or holding
// a space becomes a launcher, as pip and uv write it. Text is latin1, so a line's length is its size in bytes.
function rewriteScript(text, rewriter) {
  const [first, second = ""] = text.split("\n", 2);
  if (first.startsWith("#!") && second.startsWith(LAUNCHER)) {
    const { word, length } = shellWord(second.slice(LAUNCHER.length));
    const replacement = rewriter.rewrite(word);
    const line = replacement === word ? second : `${LAUNCHER}${shellQuote(replacement)}${second.slice(LAUNCHER.length + length)}`;
    return `${first}\n${line}${rewriter.rewrite(text.slice(first.length + 1 + second.length))}`;
  }
  const rest = rewriter.rewrite(text.slice(first.length));
  const [, interpreter = "", options = "", carriage = ""] = first.match(/^#!\s*(\S+)(.*?)(\r?)$/) ?? [];
  const replacement = rewriter.rewrite(interpreter);
  if (replacement === interpreter) return rewriter.rewrite(first) + rest;
  const line = `#!${replacement}${rewriter.rewrite(options)}`;
  if (line.length <= SHEBANG_LIMIT && !/\s/.test(replacement)) return `${line}${carriage}${rest}`;
  return `#!/bin/sh\n${LAUNCHER}${shellQuote(replacement)}${rewriter.rewrite(options)} "$0" "$@"\n' '''${rest || "\n"}`;
}

// Writes a scratch file through a new file and a rename, never through a link and never into a hard link
// that the repository may share, keeping the file's mode.
function replaceFile(path, text) {
  const temporary = `${path}${TEMPORARY}`;
  const mode = lstatSync(path).mode & 0o7777;
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(descriptor, Buffer.from(text, "latin1"));
    fchmodSync(descriptor, mode);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

function interpreterLink(venv) {
  const path = join(venv, "bin/python");
  if (!existing(path)) throw new Error(`virtualenv has no bin/python: ${venv}`);
  return path;
}

function resolveLink(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`dangling link (target missing): ${path} -> ${readlinkSync(path)}`);
    throw error;
  }
}

// cpSync leaves copied directories at the default mode, so each takes its source's mode, deepest first.
function copyDirectoryModes(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDirectoryModes(join(source, entry.name), join(target, entry.name));
  }
  chmodSync(target, lstatSync(source).mode & 0o7777);
}

// Copies a user-owned runtime into the virtualenv and relinks every bin/ link into it. A runtime is the parent
// of the bin directory holding the interpreter's canonical path, so an alias link such as uv's is resolved first.
function relocateRuntime(venv, context, log) {
  const { root, repository, home } = context;
  const bin = join(venv, "bin");
  if (!existing(bin)?.isDirectory()) throw new Error(`${bin} is not a directory`);
  const interpreter = resolveLink(interpreterLink(venv));
  if (!outside(root, interpreter) || lockedSystemFile(interpreter, home)) return;
  if (basename(dirname(interpreter)) !== "bin") {
    throw new Error(`interpreter of ${venv} is not in a bin directory: ${interpreter}`);
  }
  const runtime = dirname(dirname(interpreter));
  for (const [name, path] of [["the scratch tree", root], ["the repository", repository], ["the home directory", home]]) {
    if (!outside(runtime, path)) throw new Error(`interpreter runtime ${runtime} holds ${name}, so it is not copied`);
  }
  const runtimes = join(venv, RUNTIMES);
  const holder = existing(runtimes);
  if (holder && !holder.isDirectory()) throw new Error(`${runtimes} is not a directory`);
  if (!holder) mkdirSync(runtimes);
  const copy = join(runtimes, basename(runtime));
  removeTree(copy);
  cpSync(runtime, copy, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  copyDirectoryModes(runtime, copy);
  log(`copied runtime ${runtime} -> ${relative(root, copy)}`);
  for (const entry of readdirSync(bin, { withFileTypes: true }).filter((item) => item.isSymbolicLink())) {
    const link = join(bin, entry.name);
    if (!outside(root, resolve(bin, readlinkSync(link)))) continue;
    let target;
    try {
      target = realpathSync(link);
    } catch {
      continue;
    }
    if (outside(runtime, target)) continue;
    const replacement = relative(bin, join(copy, relative(runtime, target)));
    unlinkSync(link);
    symlinkSync(replacement, link);
    log(`relinked ${relative(root, link)} -> ${replacement}`);
  }
}

function configValue(lines, key) {
  const line = lines.find((item) => item.match(new RegExp(`^\\s*${key}\\s*=`)));
  return line?.slice(line.indexOf("=") + 1).trim();
}

// Points home, executable, and command at the runtime copied into the virtualenv. Source paths in the file are
// left to the rewrite of every text file that follows.
function updateConfig(venv, context, log) {
  const interpreter = realpathSync(interpreterLink(venv));
  if (outside(join(venv, RUNTIMES), interpreter)) return;
  const path = join(venv, "pyvenv.cfg");
  const original = readFileSync(path, "latin1");
  const lines = original.split("\n");
  const home = bytes(dirname(interpreter));
  const oldExecutable = configValue(lines, "executable");
  const executable = oldExecutable && join(home, basename(oldExecutable));
  const text = lines.map((line) => {
    const key = line.match(/^\s*(home|executable|command)\s*=/)?.[1];
    if (key === "home") return `home = ${home}`;
    if (key === "executable") return `executable = ${executable}`;
    return key === "command" && oldExecutable ? line.split(oldExecutable).join(executable) : line;
  }).join("\n");
  if (text !== original) {
    replaceFile(path, text);
    log(`updated ${relative(context.root, path)}`);
  }
}

// A temporary file an interrupted run left behind is removed before any file is written again.
function removeLeftovers(venv, context, log) {
  for (const path of regularFiles(venv).filter((file) => file.endsWith(TEMPORARY))) {
    unlinkSync(path);
    log(`removed ${relative(context.root, path)}`);
  }
}

// A binary such as a compiled extension shows a NUL byte in its first block, so it is skipped without reading
// the whole file; a file is rewritten only when it holds no NUL byte at all.
function startsBinary(path) {
  const buffer = Buffer.alloc(8192);
  const descriptor = openSync(path, "r");
  try {
    return buffer.subarray(0, readSync(descriptor, buffer, 0, buffer.length, 0)).includes(0);
  } finally {
    closeSync(descriptor);
  }
}

function rewriteSourcePaths(venv, context, rewriter, log) {
  for (const path of regularFiles(venv)) {
    if (startsBinary(path)) continue;
    const buffer = readFileSync(path);
    if (buffer.includes(0) || !rewriter.mentions(buffer)) continue;
    const original = buffer.toString("latin1");
    const text = rewriteScript(original, rewriter);
    if (text === original) continue;
    replaceFile(path, text);
    log(`rewrote ${relative(context.root, path)}`);
  }
}

function verify(venv) {
  const python = interpreterLink(venv);
  const result = spawnSync(python, ["-I", "-c", "import sys; print(sys.prefix)"], { cwd: "/", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${python} does not start: ${result.error?.message || result.stderr.trim() || `exit status ${result.status}`}`);
  }
  const prefix = result.stdout.trim();
  let same = false;
  try {
    same = realpathSync(prefix) === realpathSync(venv);
  } catch {}
  if (!same) throw new Error(`${python} runs with sys.prefix ${prefix}, not ${venv}`);
}

function prepare(repositoryArgument, scratchArgument) {
  const repositoryPath = resolve(repositoryArgument);
  if (!statSync(repositoryPath).isDirectory()) throw new Error("repository must be a directory");
  const repository = realpathSync(repositoryPath);
  const scratchPath = resolve(scratchArgument);
  const stats = existing(scratchPath);
  if (!stats) throw new Error(`scratch directory does not exist: ${scratchPath}`);
  if (stats.isSymbolicLink()) throw new Error("scratch root is a symlink");
  if (!stats.isDirectory()) throw new Error("scratch root is not a directory");
  const root = realpathSync(scratchPath);
  if (!outside(repository, root)) throw new Error("scratch directory must be outside the repository");

  const environments = virtualenvs(root);
  if (!environments.length) {
    console.log(`Scratch Python ready: no virtualenv under ${root}`);
    return;
  }
  for (const [name, path] of [["repository", repositoryPath], ["repository", repository], ["scratch", scratchPath], ["scratch", root]]) {
    if (UNWRITABLE.test(path)) {
      throw new Error(`${name} path ${JSON.stringify(path)} holds a quote, backslash, or line break, which virtualenv files store escaped or cannot hold`);
    }
  }
  const context = { root, repository, home: canonicalHome() };
  const rewriter = pathRewriter([...new Set([repositoryPath, repository])], [...new Set([scratchPath, root])], root);
  let changes = 0;
  const log = (line) => {
    changes += 1;
    console.log(line);
  };
  for (const venv of environments) {
    removeLeftovers(venv, context, log);
    relocateRuntime(venv, context, log);
    updateConfig(venv, context, log);
    rewriteSourcePaths(venv, context, rewriter, log);
    verify(venv);
  }
  const count = `${environments.length} virtualenv${environments.length === 1 ? "" : "s"}`;
  console.log(changes ? `Scratch Python prepared: ${changes} changes in ${count} under ${root}` : `Scratch Python ready: no change needed in ${count} under ${root}`);
}

const [repository, scratch, ...extra] = process.argv.slice(2);
if (!repository || !scratch || extra.length) {
  console.error("Usage: prepare-scratch-python.mjs <repository> <scratch-directory>");
  process.exitCode = 2;
} else {
  try {
    prepare(repository, scratch);
  } catch (error) {
    console.error(`Scratch Python preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
