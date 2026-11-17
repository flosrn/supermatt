import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Inside Codex's Linux sandbox, a synchronous spawn with a piped stdin throws EPERM although the child succeeded:
// Node shuts down the write side of the empty stdin socketpair and the seccomp filter refuses that shutdown(2) (#107, #111).
// Every synchronous spawn in shipped code therefore either ignores or inherits stdin, or passes `input`.

const repo = fileURLToPath(new URL("..", import.meta.url));
const shippedRoots = ["skills", "references", "scripts"];
const call = /\b(execFileSync|spawnSync|execSync)\s*\(/g;
const safeStdin = /\bstdio\s*:\s*(?:\[\s*(["'`])(?:ignore|inherit)\1|(["'`])(?:ignore|inherit)\2)|\binput\s*[:,}]/;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(?:m|c)?js$/.test(entry.name) ? [path] : [];
  });
}

// Returns the index just past the bracket that closes the one at `open`, skipping quoted text.
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return i + 1;
  }
  return text.length;
}

// Splits a call's argument list at its top-level commas.
function args(text) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("([{".includes(c)) i = closing(text, i) - 1;
    else if ("'\"`".includes(c)) {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === ",") {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

// An options identifier resolves to the nearest object literal assigned to it before the call.
function resolveOptions(text, name, before) {
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*\\{`, "g");
  let found = null;
  for (const match of text.slice(0, before).matchAll(declaration)) found = match.index + match[0].length - 1;
  return found === null ? "" : text.slice(found, closing(text, found));
}

function pipedStdinSpawns(roots) {
  const offenders = [];
  for (const root of roots) {
    for (const file of sources(root)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(call)) {
        const lineStart = text.lastIndexOf("\n", match.index) + 1;
        if (/^\s*(?:\/\/|\/?\*)/.test(text.slice(lineStart, match.index))) continue;
        const open = match.index + match[0].length - 1;
        const [, ...rest] = args(text.slice(open + 1, closing(text, open) - 1));
        const options = rest
          .filter((arg) => !arg.startsWith("["))
          .map((arg) => (/^[A-Za-z_$][\w$]*$/.test(arg) ? resolveOptions(text, arg, match.index) : arg))
          .join("\n");
        if (!safeStdin.test(options)) {
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(`${relative(repo, file)}:${line}: ${match[1]}`);
        }
      }
    }
  }
  return offenders;
}

test("no shipped synchronous spawn leaves stdin piped without input", () => {
  assert.deepEqual(pipedStdinSpawns(shippedRoots.map((root) => join(repo, root))), []);
});

test("a synchronous spawn with default options is reported with its file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "spawn-stdin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  const bad = join(root, "scripts", "status.mjs");
  writeFileSync(bad, 'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status"]);\n');
  assert.deepEqual(pipedStdinSpawns([root]), [`${relative(repo, bad)}:2: execFileSync`]);
});

test("ignored, inherited, or fed stdin passes, and a piped one does not", (t) => {
  const root = mkdtempSync(join(tmpdir(), "spawn-stdin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "calls.mjs");
  writeFileSync(file, [
    'execFileSync("git", ["status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });',
    'spawnSync("tern", args, { stdio: "inherit" });',
    'execSync("cat", { input: "x" });',
    "const quiet = { env, stdio: ['ignore','pipe','pipe'] };",
    "execFileSync('git', ['--version'], quiet);",
    '// spawnSync("comment") is not a call',
    'spawnSync("cp", ["a", "b"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });',
    "const loud = { encoding: 'utf8' };",
    "execFileSync('git', ['log'], loud);",
    'execSync("ls")',
  ].join("\n"));
  const at = (line, name) => `${relative(repo, file)}:${line}: ${name}`;
  assert.deepEqual(pipedStdinSpawns([root]), [at(7, "spawnSync"), at(9, "execFileSync"), at(10, "execSync")]);
});
