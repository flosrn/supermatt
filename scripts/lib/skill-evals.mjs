import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { digest } from "./skill-evidence.mjs";

export function collectState(root) {
  const state = Object.create(null), errors = [];
  let total = 0;
  const walk = prefix => {
    for (const name of readdirSync(resolve(root, prefix)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (path === ".git") continue;
      try {
        const absolute = resolve(root, path), stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          state[path] = { kind: "symlink", target: readlinkSync(absolute) };
          errors.push(`Unfollowed symlink: ${path}`);
        } else if (stat.isDirectory()) walk(path);
        else if (!stat.isFile()) errors.push(`Unsupported file type: ${path}`);
        else if (stat.size > 4 * 1024 * 1024 || (total += stat.size) > 16 * 1024 * 1024) {
          state[path] = { kind: "oversized", size: stat.size }; errors.push(`Capture limit: ${path}`);
        } else {
          const bytes = readFileSync(absolute);
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            state[path] = text.includes("\0") ? { kind: "binary", digest: digest(bytes), size: bytes.length } : text;
          } catch { state[path] = { kind: "binary", digest: digest(bytes), size: bytes.length }; }
        }
      } catch (error) { errors.push(`${path}: ${error.code ?? error.message}`); }
    }
  };
  try { walk(""); } catch (error) { errors.push(error.message); }
  return { state, errors };
}

const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
function onlySkillRead(command, path) {
  const payloads = [path, quote(path), JSON.stringify(path)].flatMap(p => [`cat ${p}`, `cat -- ${p}`, `/bin/cat ${p}`]);
  const permitted = new Set(payloads);
  for (const shell of ["/bin/zsh", "/bin/bash", "/bin/sh"]) for (const flag of ["-c", "-lc"]) for (const payload of payloads) {
    permitted.add(`${shell} ${flag} ${quote(payload)}`);
    permitted.add(`${shell} ${flag} ${JSON.stringify(payload)}`);
    permitted.add(`${shell} ${flag} '${payload.replaceAll("'", "'\"'\"'")}'`);
  }
  return permitted.has(command?.trim());
}

export function parseTrace(text) {
  let events;
  try { events = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { throw new Error("Malformed JSON trace"); }
  assert.ok(events.every(e => e && typeof e.type === "string" && (!e.type.startsWith("item.") || typeof e.item?.type === "string")), "Malformed trace event");
  assert.ok(!events.some(e => ["error", "turn.failed"].includes(e.type)), "Trace contains an error");
  assert.equal(events.filter(e => e.type === "turn.completed").length, 1, "Trace must contain one complete turn");
  const last = events.filter(e => e.type === "item.completed").at(-1)?.item;
  assert.ok(last?.type === "agent_message" && last.text?.trim(), "Trace has no final answer");
  return events;
}

export function grade(testCase, observation) {
  const { events, skill, before, after, process: processResult } = observation;
  const findings = [];
  if (processResult.code !== 0 || processResult.timedOut) return { status: "blocked", findings: ["Process did not complete successfully"] };
  const items = events.filter(e => e.type === "item.completed").map(e => e.item);
  const workEvent = event => ["item.started", "item.updated", "item.completed"].includes(event.type)
    && !["agent_message", "reasoning", "todo_list"].includes(event.item?.type);
  const exposure = events.findIndex(e => e.type === "item.completed" && e.item?.type === "command_execution"
    && e.item.exit_code === 0 && onlySkillRead(e.item.command, skill.path) && e.item.aggregated_output?.includes(skill.body.trim()));
  const read = events[exposure]?.item;
  const premature = events.slice(0, exposure).some(e => workEvent(e)
    && (e.type === "item.completed" || e.item.id !== read?.id || e.item.command !== read?.command));
  if (exposure < 0 || premature) {
    return { status: "blocked", findings: ["Target skill was not read in full before work"] };
  }
  for (const [path, bytes] of Object.entries(before)) {
    if (JSON.stringify(after[path]) !== JSON.stringify(bytes) && (testCase.unchanged || path !== testCase.requiredFile)) findings.push(`Source changed: ${path}`);
  }
  if (testCase.unchanged && JSON.stringify(before) !== JSON.stringify(after)) findings.push("Read-only fixture changed");
  const root = observation.fixtureRoot ?? "/fixture";
  if (testCase.unchanged && items.some(i => i.type === "file_change" && i.changes?.some(change => {
    const path = resolve(root, change.path); return path.startsWith(root + sep);
  }))) findings.push("Read-only task attempted file edits");
  if (testCase.requiredFile) {
    const output = after[testCase.requiredFile];
    if (!output || (testCase.expectedBytes !== undefined && output !== testCase.expectedBytes)) findings.push("Required output missing or incorrect");
  }
  return { status: findings.length ? "fail" : "needs review", findings, rubric: testCase.rubric };
}

export function selectCases(cases, ids) {
  if (!ids) return cases;
  const selected = ids.split(",");
  assert.ok(new Set(selected).size === selected.length, "Duplicate case selection");
  for (const id of selected) assert.ok(cases.some(c => c.id === id), `Unknown case: ${id}`);
  return cases.filter(c => selected.includes(c.id));
}

export function reviewResults(results, reviews) {
  assert.equal(new Set(reviews.map(r => r.id)).size, reviews.length, "Duplicate adjudication");
  for (const review of reviews) {
    const result = results.find(r => r.id === review.id);
    assert.ok(result, `Unknown run: ${review.id}`);
    assert.equal(result.status, "needs review", `Cannot override failed or blocked checks: ${review.id}`);
    assert.equal(review.evidenceDigest, result.evidenceDigest, "Adjudication digest mismatch");
    assert.ok(["pass", "fail"].includes(review.verdict), "Invalid adjudication verdict");
    for (const field of ["reviewer", "rationale"]) assert.ok(review[field]?.trim(), `Missing ${field}`);
    assert.ok(review.evidence?.length && review.evidence.every(p => typeof p === "string" && p.includes(":")), "Missing evidence references");
  }
  return results.map(result => {
    const review = reviews.find(r => r.id === result.id);
    return review ? { ...result, status: review.verdict, adjudication: review } : result;
  });
}

export function verdict(results) {
  if (results.some(r => !["pass", "fail", "blocked", "needs review"].includes(r.status))) return "blocked";
  if (!results.length || results.some(r => r.status === "blocked")) return "blocked";
  if (results.some(r => r.status === "fail")) return "fail";
  if (results.some(r => r.status === "needs review")) return "needs review";
  return "pass";
}

// Matches the selected cases against both frozen snapshots before any model call. The
// candidate must have every selected skill. A skill the baseline lacks (a new skill) has
// nothing to run there: its baseline rows are recorded as absent, with no CLI run.
export function planComparison(selected, skills, { conditions, repetitions }) {
  const missing = [...new Set(selected.filter(c => !skills.candidate.has(c.skill)).map(c => c.skill))];
  assert.ok(!missing.length, `The candidate snapshot lacks selected skills: ${missing.join(", ")}`);
  const absent = selected.filter(c => !skills.baseline.has(c.skill)).map(c => c.id);
  const perCase = conditions.length * repetitions;
  return { absent, plannedRuns: (selected.length * 2 - absent.length) * perCase, absentRuns: absent.length * perCase };
}

export const absentResult = id => ({ id, status: "absent", findings: ["The baseline snapshot has no such skill; nothing was run"] });

export function comparisonStatus(report) {
  // Early development reports called CLI runs plannedModelCalls. They never
  // measured the number of individual provider requests within a run.
  const planned = report.plannedRuns ?? report.plannedModelCalls;
  const absent = report.absentRuns ?? 0;
  const rows = planned + absent;
  if (report.error || !Number.isSafeInteger(planned) || !Number.isSafeInteger(absent) || absent < 0 || rows < 2 || rows % 2 !== 0
    || report.completedRuns !== rows || report.results.length !== rows) return "blocked";
  // Absent rows stand in for baseline runs of a new skill; the candidate always runs.
  const absentRows = report.results.filter(r => r.status === "absent");
  if (absentRows.length !== absent || absentRows.some(r => !r.id.startsWith("baseline-"))) return "blocked";
  const measured = report.results.filter(r => r.status !== "absent");
  if (measured.some(r => r.status === "blocked")) return "blocked";
  // Baseline defects are measurements, not candidate acceptance failures.
  const candidate = report.results.filter(r => r.id.startsWith("candidate-"));
  const baseline = report.results.filter(r => r.id.startsWith("baseline-"));
  const ids = list => list.map(r => r.id.slice(r.id.indexOf("-") + 1)).sort();
  if (candidate.length !== rows / 2 || baseline.length !== rows / 2
    || new Set(report.results.map(r => r.id)).size !== rows
    || JSON.stringify(ids(candidate)) !== JSON.stringify(ids(baseline))) return "blocked";
  if (candidate.some(r => r.status === "fail")) return "fail";
  if (verdict(measured) === "blocked") return "blocked";
  if (measured.some(r => r.status === "needs review")) return "needs review";
  return verdict(candidate);
}

export function redact(text, secrets = []) {
  let result = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join("<REDACTED>");
  return result.replace(/(Bearer\s+)[A-Za-z0-9_.~+\/-]+/gi, "$1<REDACTED>")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, "$1<REDACTED>");
}
