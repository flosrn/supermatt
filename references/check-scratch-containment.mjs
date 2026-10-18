#!/usr/bin/env node
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length) {
  console.error("Usage: check-scratch-containment.mjs <scratch-directory>");
  process.exitCode = 2;
} else {
  try {
    if (lstatSync(resolve(directory)).isSymbolicLink()) throw new Error("scratch root is a symlink");
    const root = realpathSync(directory);
    const pending = [root];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) {
          const target = realpathSync(path);
          const offset = relative(root, target);
          if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)) {
            throw new Error(`symlink escapes scratch: ${path} -> ${target}`);
          }
        } else if (entry.isDirectory()) {
          pending.push(path);
        }
      }
    }
    console.log(`Scratch containment verified: ${root}`);
  } catch (error) {
    console.error(`Unsafe scratch tree ${resolve(directory)}: ${error.message}`);
    process.exitCode = 1;
  }
}
