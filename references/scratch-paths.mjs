import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function outside(base, path) {
  const offset = relative(base, path);
  return isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`);
}

export function canonicalHome() {
  try {
    return realpathSync(homedir());
  } catch {
    return resolve(homedir());
  }
}

// The canonical form of a path that may not exist: its nearest existing ancestor resolved, the rest appended.
export function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    const parent = dirname(absolute);
    if (parent === absolute || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) return absolute;
    return join(canonicalPath(parent), basename(absolute));
  }
}

// A path may leave scratch only for a system file the user cannot change: a non-directory owned by root,
// not writable by the user, and outside the user's home, such as a virtualenv's interpreter link.
export function lockedSystemFile(path, home) {
  try {
    accessSync(path, constants.W_OK);
    return false;
  } catch {
    try {
      const stats = statSync(path);
      return stats.uid === 0 && !stats.isDirectory() && outside(home, path);
    } catch {
      return false;
    }
  }
}

// An interpreter path named in a file, such as a shebang, also needs its own entry owned by root: a link the user
// owns, such as another virtualenv's bin/python, runs that environment even when it ends at a locked system file.
export function lockedSystemEntry(path, home) {
  try {
    return lstatSync(path).uid === 0 && lockedSystemFile(realpathSync(path), home);
  } catch {
    return false;
  }
}

// Line 2 of the /bin/sh launcher that pip and uv write when a #! line would be too long or hold a space:
// sh runs it, while Python reads it as the start of a string that the next line closes.
export const LAUNCHER = "'''exec' ";

// The first shell word of a text with its quoted and backslash-escaped parts unquoted, so a path written as
// '/a/it'\''s copy' reads back as /a/it's copy, and the length of its written form.
export function shellWord(line) {
  const [written] = line.match(/^(?:'[^']*'|"[^"]*"|\\.|[^\s'"\\])*/);
  return { word: written.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_, single, double, escaped) => single ?? double ?? escaped), length: written.length };
}

// The interpreter a script's first lines name: the launcher's, whose quoted path may span lines, or the #!
// line's first word.
export function scriptInterpreter(text) {
  const end = text.indexOf("\n");
  const first = end === -1 ? text : text.slice(0, end);
  if (!first.startsWith("#!")) return null;
  const rest = end === -1 ? "" : text.slice(end + 1);
  return rest.startsWith(LAUNCHER) ? shellWord(rest.slice(LAUNCHER.length)).word : first.slice(2).trim().split(/\s/)[0];
}
