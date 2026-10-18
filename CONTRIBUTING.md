# Contributing

Bug reports, skill ideas, and pull requests are welcome. For a new skill or a large change, open an issue first so we can agree on the shape before you write it.

## Set up

Fork the repository and clone your fork. Install [lefthook](https://lefthook.dev) and [betterleaks](https://github.com/betterleaks/betterleaks), then turn on the git hooks. They scan commits for secrets and dashes, check commit messages, and run the tests before a push:

```
brew install lefthook betterleaks
lefthook install
```

To try your working copy in Claude Code, start a session with the plugin loaded from disk:

```
claude --plugin-dir .
```

In Codex, add your clone as a marketplace and install from it:

```
codex plugin marketplace add .
codex plugin add supermatt@supermatt
```

Load the checkout directly in Cursor Agent CLI:

```
agent --plugin-dir .
```

Load it directly in OMP:

```
omp --plugin-dir .
```

For an isolated OMP marketplace smoke, use a temporary OMP profile, add this checkout as its marketplace, then run:

```text
omp plugin marketplace add "$PWD"
```

```
omp plugin install --dry-run --scope user supermatt@supermatt
omp --plugin-dir "$PWD" --no-session -p --model MODEL '/skill:ask-supermatt I need to fix a reproducible bug'
```

Remove only the temporary profile after preserving the smoke output. Never reuse or delete the normal user profile.

## Check your change

Run these checks before you open a pull request. CI runs them too:

```
claude plugin validate --strict .
claude plugin validate --strict ./skills
sh tests/link-skills.test.sh
sh tests/mutate.test.sh
sh tests/release.test.sh
sh tests/directory-branch.test.sh
bun test tests/
```

`bun test tests/` runs the JavaScript tests, including orchestration, scratch dependencies, QA scratch sources, plugin discovery, and evaluation controls. CI runs them with Node's built-in test runner. `tests/link-skills.test.sh` tests `scripts/link-skills.sh` and syntax-checks the shell templates in `skills/`. `tests/mutate.test.sh` tests the `tdd` skill's mutation runner. `tests/release.test.sh` and `tests/directory-branch.test.sh` test the maintainer's `scripts/release.sh` and `scripts/directory-branch.sh`.

### Codex-only discovery and behavioral evaluation

`scripts/test-plugin-discovery.mjs` and `scripts/evaluate-skills.mjs` are Codex runtime checks. They do not verify Claude Code, Cursor, or OMP execution. These opt-in checks use the installed Codex CLI and Git; behavioral evaluation also requires Node for fixture execution. Bun is the preferred driver. They never install or upgrade a tool, modify your installed plugins, or publish a report. Unavailable host coverage must be recorded as unobserved.

```sh
bun scripts/test-plugin-discovery.mjs
bun scripts/evaluate-skills.mjs --model MODEL --baseline BASE_COMMIT --dry-run
bun scripts/evaluate-skills.mjs --model MODEL --baseline BASE_COMMIT
```

Discovery uses a temporary home without credentials. It builds the release projection, checks native discovery and every installed resource, removes the temporary source carrier, and checks again. Installed invocation metadata is verified byte-for-byte; current Codex discovery does not expose runtime invocation-policy enforcement. Discovery starts no model turn and does not prove execution.

Behavioral evaluation makes paid model calls using your existing native Codex authentication. Both source snapshots are frozen before the first call, and the selected cases are checked against both: a case whose skill the candidate lacks stops the run before any call, and a case whose skill the baseline lacks (a new skill) runs only in the candidate, with its baseline rows recorded as `absent` and listed under `baselineAbsent`. The default is three runs of each case under supportive, neutral, and competing prompts, on both baseline and candidate: use `--dry-run` to see the CLI run count. Each run can make multiple provider requests; their count and cost are not estimated. `--cases report-only,handoff`, `--variants neutral`, `--runs 1`, and `--timeout 300` bound a diagnostic run. `--candidate REVISION` selects a committed candidate; the default snapshots tracked and unignored working files. Use the same explicit model for a comparison; reasoning effort is medium. Record a missing reported model as unknown, not as a verified provider pin.

Each model receives an isolated fixture and a read-only installed plugin. A native permissions profile restricts commands to the fixture, its temporary artifact directory, required runtime paths, and plugin resources. The preflight checks denied reads and writes, an allowed fixture write, Git and Node startup, and a denied connection to a live loopback listener with a positive control. It stops before model calls when that boundary cannot be verified. This qualifies native command isolation, not a general hostile-plugin sandbox. Fixtures and plugin code must be trusted. Existing authentication is available to the parent CLI, outside model-tool grants; shell environments omit credentials. Effective configuration is checked for enabled MCP servers, integrations, hooks, memory, and tool network access. The fixture shell uses explicit tool paths, no Bun transpiler cache, and an empty OpenSSL configuration; these probes do not qualify application TLS behavior.

The corpus contains scoped behavior probes, not complete tracker, Herdr, browser, or release workflows. Mechanical checks cover target exposure, completed execution, file state, and required outputs. A maintainer supplies semantic judgments by reviewing the saved trace, artifacts, and each case's rubric; the runner has no automatic LLM judge. A successful process or a matching phrase alone never earns a pass. Do not put expected answers or adjudications in the readable fixture.

Reports, the harness sources, redacted traces and observations remain in the printed OS temporary directory after execution state is removed. Binary cache files are represented by size and digest, not treated as textual evidence. Symlinks are recorded without following them and block grading; capture errors preserve the trace and partial observation. The runner returns nonzero for `fail`, `blocked`, or `needs review`, and stops after a blocked model run. A passing candidate acceptance suite requires every selected condition and repetition to pass; a measured baseline failure does not fail candidate acceptance. Retain failed attempts when rerunning. Do not generalize a small observed difference into statistical proof of improvement.

To adjudicate, write a JSON array outside the fixture. Each entry names a run `id`, its `evidenceDigest` from `report.json`, a `verdict` of `pass` or `fail`, `reviewer`, `rationale`, and `evidence` references such as `candidate-handoff-neutral-1/observation.json:12`. Inspect the actual evidence against every rubric item, including shell commands that could edit and then restore a file. Failed or blocked mechanical checks cannot be overridden. Then run:

```sh
bun scripts/evaluate-skills.mjs --adjudicate /absolute/report/directory --reviews /absolute/reviews.json
```

This rechecks trace integrity and mechanical assertions against the matching corpus, writes a separate adjudicated report, and preserves the original. An empty reviews array rechecks evidence without assigning semantic passes. An incomplete run stays blocked. Deterministic evaluator controls run in CI; authenticated behavioral comparisons and native discovery run explicitly on a maintainer machine. If authentication, permissions, or the selected model is unavailable, report that gap without weakening the boundary.

## Rules for a change

[AGENTS.md](./AGENTS.md) states what an acceptable change must satisfy. Read it before you edit a skill. It covers the skill layout, the README entry, the `ask-supermatt` router, the version bump, the `CHANGELOG.md` entry, and the ban on em dashes.

## Open a pull request

1. Create a branch named `type/kebab-description`, such as `fix/tdd-red-check`.
2. Write commits as Conventional Commits: `type(scope): description`. Accepted types: `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`.
3. Open the pull request against `main` and fill in the template.

Pull requests are squash merged.

## Who decides

Leonid Svyatov maintains SuperMatt and is the only person who merges and releases. No successor is arranged.
