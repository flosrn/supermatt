#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";
import { run } from "./lib/skill-evidence.mjs";

const maximumBytes = 4 * 1024 * 1024;

// This factory is also sent as trusted source to the restricted child. Capture
// the data operations before importing the candidate, and never invoke getters
// or toJSON while turning its exports into plain JSON data.
function catalogueValidator(isProxy) {
  const { getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn } = Object;
  const ownKeys = Reflect.ownKeys, isArray = Array.isArray, finite = Number.isFinite;
  const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const stringify = JSON.stringify;
  const fail = message => { throw new Error(`Invalid evaluation catalogue: ${message}`); };
  const plain = value => value !== null && typeof value === "object" && !isArray(value);
  const clone = (value, path, ancestors) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && finite(value)) return value;
    if (typeof value !== "object") fail(`${path} is not JSON data (${typeof value})`);
    if (isProxy(value)) fail(`${path} is not plain data (Proxy)`);
    const array = isArray(value), prototype = getPrototypeOf(value);
    if (array ? prototype !== arrayPrototype : prototype !== objectPrototype && prototype !== null) fail(`${path} is not plain data`);
    if (ancestors.includes(value)) fail(`${path} is circular`);
    const result = array ? [] : {}, next = [...ancestors, value];
    const keys = ownKeys(value);
    if (array) {
      const length = getOwnPropertyDescriptor(value, "length").value;
      if (keys.length !== length + 1) fail(`${path} has sparse or extra array properties`);
    }
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") fail(`${path} has a symbol property`);
      if (array && !/^(0|[1-9]\d*)$/.test(key)) fail(`${path} has an extra array property`);
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !("value" in descriptor)) fail(`${path}.${key} is not an enumerable data property`);
      defineProperty(result, key, { value: clone(descriptor.value, `${path}.${key}`, next), enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  const identifier = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value);
  const text = value => typeof value === "string" && value.trim().length > 0;
  const fixturePath = value => typeof value === "string" && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
  return value => {
    const data = clone(value, "catalogue", []);
    if (!plain(data) || ownKeys(data).length !== 2 || !isArray(data.cases) || !plain(data.variants)) fail("expected cases array and variants object only");
    if (!data.cases.length || !ownKeys(data.variants).length) fail("cases and variants must not be empty");
    const ids = [];
    for (const c of data.cases) {
      if (!plain(c) || !identifier(c.id) || !identifier(c.skill) || !text(c.prompt)) fail("each case needs a safe id, skill and nonempty prompt");
      if (ids.includes(c.id)) fail(`duplicate case: ${c.id}`);
      ids.push(c.id);
      if (!plain(c.files) || !ownKeys(c.files).every(path => fixturePath(path) && typeof c.files[path] === "string")) fail(`${c.id} has invalid fixture files`);
      if (!isArray(c.rubric) || !c.rubric.length || !c.rubric.every(text)) fail(`${c.id} needs a nonempty text rubric`);
      if (hasOwn(c, "unchanged") && typeof c.unchanged !== "boolean") fail(`${c.id} has invalid unchanged flag`);
      if (hasOwn(c, "requiredFile") && !fixturePath(c.requiredFile)) fail(`${c.id} has invalid requiredFile`);
      if (hasOwn(c, "expectedBytes") && typeof c.expectedBytes !== "string") fail(`${c.id} has invalid expectedBytes`);
    }
    for (const name of ownKeys(data.variants)) if (!identifier(name) || typeof data.variants[name] !== "string") fail("variants need safe names and text values");
    // Check serializability here, before a caller can accidentally drop values.
    stringify(data);
    return data;
  };
}

const catalogueData = catalogueValidator(types.isProxy);

export function readCatalogue(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maximumBytes) throw new Error("Evaluation catalogue must be a regular JSON file of at most 4 MiB");
  const bytes = readFileSync(path);
  return { bytes, data: catalogueData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) };
}

async function main() {
  const [snapshotPath, output, ...extra] = process.argv.slice(2);
  if (!snapshotPath || !output || extra.length || !isAbsolute(output)) throw new Error("Usage: node export-eval-catalogue.mjs <candidate-snapshot-dir> <absolute-output.json>");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (process.versions.bun || major < 22 || (major === 22 && minor < 13)) throw new Error("Catalogue export requires Node >=22.13 with the permission model");
  const suppliedRoot = resolve(snapshotPath);
  if (lstatSync(suppliedRoot).isSymbolicLink()) throw new Error("Unsupported symlink in candidate snapshot root");
  const root = realpathSync(suppliedRoot);
  if (root.includes("*")) throw new Error("Candidate snapshot path must not contain a permission wildcard");
  const inspect = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Unsupported symlink in candidate snapshot: ${path}`);
    if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
    else if (!stat.isFile()) throw new Error(`Unsupported resource in candidate snapshot: ${path}`);
  };
  if (!lstatSync(root).isDirectory()) throw new Error("Candidate snapshot must be a directory");
  inspect(root);
  const entry = join(root, "tests/evals/cases.mjs");
  if (!lstatSync(entry).isFile()) throw new Error("Candidate tests/evals/cases.mjs must be a regular file");
  const script = `import { types } from 'node:util';
const validate = (${catalogueValidator.toString()})(types.isProxy);
const stringify = JSON.stringify, write = process.stdout.write.bind(process.stdout);
const module = await import(${JSON.stringify(pathToFileURL(entry).href)});
write(stringify(validate({ cases: module.cases, variants: module.variants })) + "\\n");`;
  // Node permissions are not a malicious-code sandbox. In Node 22/24 they do
  // not restrict network access. Keep the snapshot private and immutable while
  // this separate, environment-empty process runs; do not claim OS isolation.
  const bytes = await run(process.execPath, ["--permission", `--allow-fs-read=${root}`, "--input-type=module", "--eval", script],
    { cwd: root, env: {}, timeout: 5000, maxBytes: maximumBytes, binary: true });
  catalogueData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  writeFileSync(output, bytes, { mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
