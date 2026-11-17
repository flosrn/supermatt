import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Inside Codex's Linux sandbox, a synchronous spawn with a piped stdin throws EPERM although the child succeeded:
// Node shuts down the write side of the empty stdin socketpair and the seccomp filter refuses that shutdown(2) (#107, #111).
// Every synchronous spawn in shipped code therefore either ignores or inherits stdin, or passes `input`, in an options
// object written at the call: options held in a variable stay unproven, since a mutation or an alias can pipe stdin again.
// The guard reads source text, not values: an `input` given as a variable, property or call result is trusted to hold
// data, because only running the code could show it evaluates to null or undefined.

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

// Splits a call's argument list at its top-level commas, or an expression at another top-level separator.
function args(text, separator = ",") {
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("([{".includes(c)) i = closing(text, i) - 1;
    else if ("'\"`".includes(c)) {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === separator) {
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

// A quoted string or template literal that is the whole value, and its text.
function stringLiteral(value) {
  const quote = value[0];
  if (!"'\"`".includes(quote) || value.length < 2) return null;
  let i = 1;
  for (; i < value.length && value[i] !== quote; i++) if (value[i] === "\\") i++;
  return i === value.length - 1 ? value.slice(1, -1) : null;
}

const detaches = (value) => {
  const text = stringLiteral(value);
  if (text !== null) return text === "ignore" || text === "inherit";
  if (!value.startsWith("[") || closing(value, 0) !== value.length) return false;
  const [first = ""] = args(value.slice(1, -1));
  return ["ignore", "inherit"].includes(stringLiteral(first));
};

// What a caller passes as data: a string or template literal, a constructed buffer, a concatenation with a string
// literal, or a variable, property or call result. A keyword value (null, undefined, false, void ...) and any other
// operator may evaluate to nothing, so it proves no input.
function feeds(value) {
  while (value.startsWith("(") && closing(value, 0) === value.length) value = value.slice(1, -1).trim();
  if (stringLiteral(value) !== null) return true;
  const operands = args(value, "+");
  if (operands.length > 1) return operands.some((operand) => stringLiteral(operand) !== null);
  const [reference] = /^(?:new\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(value) ?? [""];
  if (!reference || /^(?:null|undefined|void|false|true|NaN|Infinity|typeof|delete|await)\b/.test(value)) return false;
  const rest = value.slice(reference.length).trim();
  return rest === "" || (rest.startsWith("(") && closing(rest, 0) === rest.length);
}

// An accessor or method property's key: `get input() {}`, `async report() {}`.
const methodKey = /^(?:(?:get|set|async)\s+)?\*?\s*(?:([A-Za-z_$][\w$]*)|(["'])([^"']*)\2)\s*\(/;

// Whether an options literal's own top-level properties ignore or inherit stdin, or feed it an input. Only plain
// `key: value` and shorthand properties settle stdio or input: an accessor or method named stdio or input unproves
// that one, and a spread or computed key may redefine either, so it unproves both until a later plain property.
function stdinIsSafe(literal) {
  let detached = false;
  let fed = false;
  for (const part of args(literal.slice(1, -1))) {
    const property = /^(?:([A-Za-z_$][\w$]*)|(["'])([^"']*)\2)\s*(?::\s*([\s\S]*))?$/.exec(part);
    if (!property) {
      const method = methodKey.exec(part);
      const key = method && (method[1] ?? method[3]);
      if (!method || key === "stdio") detached = false;
      if (!method || key === "input") fed = false;
      continue;
    }
    const key = property[1] ?? property[3];
    const value = (property[4] ?? key).trim();
    if (key === "input") fed = feeds(value);
    else if (key === "stdio") detached = detaches(value);
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
        const safe = rest.some((arg) => arg.startsWith("{") && stdinIsSafe(arg));
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

test("ignored, inherited, or fed stdin written at the call passes, and anything else does not", (t) => {
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
  // Named options are unproven even when declared safe: a later mutation (`quiet.stdio = "pipe"`,
  // `delete quiet.stdio`, `Object.assign(quiet, ...)`) or an alias can pipe stdin again.
  assert.deepEqual(pipedStdinSpawns([root]), [at(5, "execFileSync"), at(7, "spawnSync"), at(9, "execFileSync"), at(10, "execSync")]);
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
    'execFileSync("git", [], { stdio: "ignore", stdio: "pipe" });',
    'execFileSync("git", [], { input: null });',
    'execFileSync("git", [], { input: undefined });',
    'execFileSync("cat", [], { input });',
  ].join("\n"));
  const at = (line, name) => `${relative(repo, file)}:${line}: ${name}`;
  assert.deepEqual(pipedStdinSpawns([root]), [
    at(2, "execFileSync"), at(3, "execFileSync"), at(6, "execFileSync"), at(7, "run"), at(10, "spawnSync"), at(12, "execFileSync"),
    at(13, "execFileSync"), at(14, "execFileSync"),
  ]);
});

test("only a plain literal stdio or a present input value proves stdin, whatever else the literal holds", (t) => {
  const root = mkdtempSync(join(tmpdir(), "spawn-stdin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "forms.mjs");
  writeFileSync(file, [
    'execFileSync("git", [], { input: (null) });',
    'execFileSync("git", [], { input: void(0) });',
    'execFileSync("git", [], { input: void 1 });',
    'execFileSync("git", [], { input: null ?? undefined });',
    'execFileSync("git", [], { stdio: ["ignore", "pipe", "pipe"], ["stdio"]: "pipe" });',
    'execFileSync("git", [], { input: "x", get input() { return null; } });',
    'execFileSync("git", [], { stdio: "ignore", stdio() {} });',
    'execFileSync("git", [], { stdio: ["ignore"].map(() => "pipe") });',
    'execFileSync("cat", [], { input: body.text });',
    'execFileSync("cat", [], { input: render(x) });',
    'execFileSync("cat", [], { input: `a${b}` });',
    'execFileSync("git", [], { stdio: `inherit` });',
    'execFileSync("git", [], { input: false });',
    'execFileSync("git", [], { stdio: "ignore", set stdio(value) {} });',
    'execFileSync("cat", [], { input: ("hello") });',
    'execFileSync("cat", [], { input: "a" + b });',
    'execFileSync("cat", [], { input: new Uint8Array([104, 105]) });',
    'execFileSync("cat", [], { input: "hello", get note() { return 1; } });',
    'execFileSync("git", [], { stdio: "ignore", async report() {} });',
  ].join("\n"));
  const at = (line) => `${relative(repo, file)}:${line}: execFileSync`;
  assert.deepEqual(pipedStdinSpawns([root]), [1, 2, 3, 4, 5, 6, 7, 8, 13, 14].map(at));
});
