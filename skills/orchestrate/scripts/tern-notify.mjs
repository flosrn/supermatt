#!/usr/bin/env node
// Shows TITLE and BODY as a Tern notification of the pane this runs in. Tern turns a program's
// OSC 777 notification into a toast and an inbox entry of the pane whose terminal received it, so
// the sequence goes to the terminal of the pane's shell: an agent's tool commands have none.
// Usage: tern-notify.mjs TITLE [BODY]. Needs TERN_PANE, which Tern sets in every pane, and the tern CLI.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [title, body = ""] = process.argv.slice(2);
const pane = process.env.TERN_PANE;
if (!title || !pane) {
  console.error("usage: tern-notify.mjs TITLE [BODY], run inside a Tern pane (TERN_PANE)");
  process.exit(2);
}

// OSC 777 splits its fields on ";", and a control character would end the sequence early.
const clean = (s) => s.replace(/[\x00-\x1f\x7f;]/g, " ");
const { child } = JSON.parse(execFileSync("tern", ["process", pane, "--json"], { encoding: "utf8" }));
const tty = execFileSync("ps", ["-o", "tty=", "-p", String(child.pid)], { encoding: "utf8" }).trim();
if (!/^(ttys\d+|pts\/\d+)$/.test(tty)) {
  console.error(`tern-notify: the shell of pane ${pane} has no terminal (${tty || "none"})`);
  process.exit(1);
}
writeFileSync(`/dev/${tty}`, `\x1b]777;notify;${clean(title)};${clean(body)}\x07`);
