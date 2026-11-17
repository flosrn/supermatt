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
const spawners = ["execFileSync", "spawnSync", "execSync"];
const detachedStdin = /^(["'`])(?:ignore|inherit)\1$|^\[\s*(["'`])(?:ignore|inherit)\2/;

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

// Blanks comments, keeping line breaks and offsets, so commented-out text never reads as code. Quoted strings,
// template text and regular expression literals are skipped whole, so a quote or slash inside them is inert.
function blankComments(text) {
  const out = text.split("");
  const substitutions = [];
  let last = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const end = text[i + 1] === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2) + 2;
      const stop = end > i ? end : text.length;
      for (let k = i; k < stop; k++) if (out[k] !== "\n") out[k] = " ";
      i = stop - 1;
    } else if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
      last = c;
    } else if (c === "`" || (c === "}" && substitutions.at(-1) === 0)) {
      if (c === "}") substitutions.pop();
      for (i++; i < text.length && text[i] !== "`"; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "$" && text[i + 1] === "{") {
          substitutions.push(0);
          i++;
          break;
        }
      }
      last = "`";
    } else if (c === "/" && /^$|[(,=:[!&|?{};+\-*%<>~^]/.test(last)) {
      let inClass = false;
      for (i++; i < text.length && text[i] !== "\n"; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        else if (text[i] === "/" && !inClass) break;
      }
      last = "/";
    } else {
      if (substitutions.length && c === "{") substitutions[substitutions.length - 1]++;
      else if (substitutions.length && c === "}") substitutions[substitutions.length - 1]--;
      if (!/\s/.test(c)) last = c;
    }
  }
  return out.join("");
}

// The spawn functions' names in a file, including the local names it imports them under.
function spawnerNames(code) {
  const names = new Set(spawners);
  const lists = [
    ...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g),
    ...code.matchAll(/\{([^}]*)\}\s*=\s*(?:require|await\s+import)\(\s*["'](?:node:)?child_process["']/g),
  ];
  for (const [, list] of lists) {
    for (const specifier of list.split(",")) {
      const [name, alias] = specifier.split(/\s+as\s+|:/).map((part) => part.trim());
      if (alias && spawners.includes(name)) names.add(alias);
    }
  }
  return [...names];
}

const escaped = (name) => name.replace(/\$/g, "\\$");

// The object literal an options argument holds: written inline, or last assigned to its identifier before the call.
function literalOf(code, arg, before) {
  if (arg.startsWith("{")) return arg;
  if (!/^[A-Za-z_$][\w$]*$/.test(arg)) return null;
  let value = null;
  for (const match of code.slice(0, before).matchAll(new RegExp(`(?<![\\w$.])${escaped(arg)}\\s*=(?![=>])\\s*`, "g"))) {
    value = match.index + match[0].length;
  }
  return value !== null && code[value] === "{" ? code.slice(value, closing(code, value)) : null;
}

// Whether an options literal's own top-level properties ignore or inherit stdin, or feed it `input`.
// A later spread may override either, so it leaves stdin unproven.
function stdinIsSafe(literal) {
  let detached = false;
  let fed = false;
  for (const part of args(literal.slice(1, -1))) {
    if (part.startsWith("...")) {
      detached = fed = false;
      continue;
    }
    const property = /^(?:([A-Za-z_$][\w$]*)|(["'])([^"']*)\2)\s*(?::\s*([\s\S]*))?$/.exec(part);
    if (!property) continue;
    const key = property[1] ?? property[3];
    const value = property[4] ?? key;
    if (key === "input") fed = true;
    else if (key === "stdio") detached = detachedStdin.test(value.trim());
  }
  return detached || fed;
}

function pipedStdinSpawns(roots) {
  const offenders = [];
  for (const root of roots) {
    for (const file of sources(root)) {
      const code = blankComments(readFileSync(file, "utf8"));
      const call = new RegExp(`(?<![\\w$])(${spawnerNames(code).map(escaped).join("|")})\\s*\\(`, "g");
      for (const match of code.matchAll(call)) {
        const open = match.index + match[0].length - 1;
        const [, ...rest] = args(code.slice(open + 1, closing(code, open) - 1));
        const safe = rest.some((arg) => {
          const literal = literalOf(code, arg, match.index);
          return literal !== null && stdinIsSafe(literal);
        });
        if (!safe) {
          const line = code.slice(0, match.index).split("\n").length;
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

test("only the options' own top-level stdio or input counts, and aliases are calls too", (t) => {
  const root = mkdtempSync(join(tmpdir(), "spawn-stdin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "tricky.mjs");
  writeFileSync(file, [
    'import { execFileSync as run, spawnSync } from "node:child_process";',
    'execFileSync("git", [], { env: { input: "hello" } });',
    'execFileSync("git", [], { encoding: "utf8" /* stdio: "ignore" */ });',
    'let options = { stdio: "ignore" };',
    'options = { encoding: "utf8" };',
    'execFileSync("git", [], options);',
    'run("git", ["status"]);',
    'execFileSync("git", [], { "stdio": "ignore" });',
    'execFileSync("git", [], { "input": "hello" });',
    'spawnSync("git", [], { stdio: "ignore", ...extra });',
    'const re = /["`]/; spawnSync("git", [], { stdio: ["ignore", "pipe", "pipe"] });',
  ].join("\n"));
  const at = (line, name) => `${relative(repo, file)}:${line}: ${name}`;
  assert.deepEqual(pipedStdinSpawns([root]), [at(2, "execFileSync"), at(3, "execFileSync"), at(6, "execFileSync"), at(7, "run"), at(10, "spawnSync")]);
});
