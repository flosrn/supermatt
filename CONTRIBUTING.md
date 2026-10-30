# Contributing

Bug reports, skill ideas, and pull requests are welcome. For a new skill or a large change, open an issue first so we can agree on the shape before you write it.

## Set up

Fork the repository and clone your fork. Install [lefthook](https://lefthook.dev) and [betterleaks](https://github.com/betterleaks/betterleaks), then turn on the git hooks. They scan commits for secrets and dashes, keep changelog edits under Unreleased, check commit messages, and run the tests before a push:

```
brew install lefthook betterleaks
lefthook install
```

The hooks are the local fast path and CI is the guarantee: the Validate workflow's `lint` job runs the same dash, whitespace and secrets checks over the pull request's commits, so a commit made without the hooks still gets checked.

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
for t in tests/*.test.sh; do sh "$t" || exit 1; done
bun test tests/
```

`bun test tests/` runs the JavaScript tests, including PR discovery and monitoring state, recovery budgets, review snapshots, orchestration, scratch dependencies, QA scratch sources, plugin discovery, and evaluation controls. CI runs them with Node's built-in test runner. The local shell loop runs every `tests/*.test.sh` file and stops on the first failure, matching the pre-push hook. `tests/link-skills.test.sh` tests `scripts/link-skills.sh` and syntax-checks the shell templates in `skills/`. `tests/mutate.test.sh` tests the `tdd` skill's mutation runner. `tests/release.test.sh` and `tests/directory-branch.test.sh` test the maintainer's `scripts/release.sh` and `scripts/directory-branch.sh`. `tests/changelog-unreleased.test.sh` tests `scripts/check-changelog-unreleased.sh`, the changelog guard that the pre-commit hook and CI run. `tests/dashes-whitespace.test.sh` tests `scripts/check-dashes-whitespace.sh`, the dash and whitespace check that CI's `lint` job runs. `tests/tui.test.sh` requires tmux and tests the `qa` terminal helper, including process-cleanup regressions on a private tmux server.

The changelog guard reports the protected base heading and complete new-side range for mixed Unreleased/released hunks, because replacement lines cannot be unambiguously aligned. Edits wholly within protected content report their new-side start line; pure deletions use Git's new-side anchor.

To run the `lint` job's dash and whitespace checks locally, compare your branch with `main`:

```
sh scripts/check-dashes-whitespace.sh origin/main HEAD
```

It judges only the lines your branch adds since its merge base with `main`: each added line holding an en or em dash is reported with its file and line, and whitespace errors with the diagnostics `git diff --check` prints. Reports name the location and never the line's content, so a secret on an offending line stays out of the CI log; open the file at that line to see it. In CI, the job runs this script over the pull request's range (on a push to `main`, the pushed range) and scans the range's commits with a checksum-pinned betterleaks v1.9.0, which prints findings redacted.

Dash locations decode Git's quoted pathnames and ignore inter-hunk context settings, so spaced or escaped names and nearby changes keep their actual locations. Git warnings can quote source content too: the script replaces their stderr with a content-free notice while preserving command failure status.

The workflow also captures betterleaks stderr, which can relay Git warnings outside the scanner's finding redaction, and substitutes a content-free notice. Redacted findings on stdout remain visible; a scanner error still fails the job.

CI runs the JavaScript tests with this command:

```
node --test tests/*.test.mjs
```

`bun test tests/` and `node --test tests/*.test.mjs` each take about 3 to 3.5 minutes. Run each runner in its own tool call with a timeout of at least 10 minutes, never chained with the other checks or with each other. A red runner still blocks the commit, so check its exit status before you commit. Keep the runner's full output, unfiltered: the summary comes at the end, and Node prints it as `ℹ tests N`, `ℹ pass N`, and `ℹ fail N` lines, not as TAP `#` lines, so a filter for `# tests` finds nothing.

The shell loop and pre-push hook need no TUI environment overrides. `tests/tui.test.sh` checks the exact spacing after the private-use folder glyph (U+F07B) using the pane's terminal settings. On Linux, `tui.sh` enables kernel tab expansion (`TAB3`): with `IUTF8` enabled, the kernel counts the glyph as one column and inserts seven spaces before `end`; without it, the kernel counts its three UTF-8 bytes and inserts five. This difference occurs before tmux renders the text, not in its `wcwidth` implementation. The suite also exercises the exact five-space case explicitly on Linux; other platforms keep the original five-space comparison. No space-count assertion is skipped in CI or locally.

### Codex-only discovery and behavioral evaluation

`scripts/test-plugin-discovery.mjs` and `scripts/evaluate-skills.mjs` are Codex runtime checks. They do not verify Claude Code, Cursor, or OMP execution. These opt-in checks use the installed Codex CLI and Git; behavioral evaluation also requires Node for fixture execution. Bun is the preferred driver. They never install or upgrade a tool, modify your installed plugins, or publish a report. Unavailable host coverage must be recorded as unobserved.

```sh
bun scripts/test-plugin-discovery.mjs
bun scripts/evaluate-skills.mjs --model MODEL --baseline BASE_COMMIT --dry-run
bun scripts/evaluate-skills.mjs --model MODEL --baseline BASE_COMMIT
```

Discovery uses a temporary home without credentials. It builds the release projection, checks native discovery and every installed resource, removes the temporary source carrier, and checks again. Installed invocation metadata is verified byte-for-byte; current Codex discovery does not expose runtime invocation-policy enforcement. Discovery starts no model turn and does not prove execution.

Behavioral evaluation makes paid model calls using your existing native Codex authentication. Both source snapshots are frozen before the first call, and the selected cases are checked against both: a case whose skill the candidate lacks stops the run before any call, and a case whose skill the baseline lacks (a new skill) runs only in the candidate, with its baseline rows recorded as `absent` and listed under `baselineAbsent`. The default is three runs of each case under supportive, neutral, and competing prompts, on both baseline and candidate: use `--dry-run` to see the CLI run count. Each run can make multiple provider requests; their count and cost are not estimated. `--cases report-only,handoff`, `--variants neutral`, `--runs 1`, and `--timeout 300` bound a diagnostic run. `--candidate REVISION` selects a committed candidate; the default snapshots tracked and unignored working files. Use the same explicit model for a comparison; reasoning effort is medium. Record a missing reported model as unknown, not as a verified provider pin.

Each model receives an isolated fixture and a read-only installed plugin. A native permissions profile restricts commands to the fixture, its temporary artifact directory, required runtime paths, and plugin resources. The fixture is a fresh Git repository per run, and the profile grants write access to its own `.git` explicitly, since Codex otherwise keeps `.git` read-only under a writable root; `.codex`, `.agents`, and `.aws` keep that default. Because a run can then rewrite its repository configuration, and Git executes parts of it (for example `core.fsmonitor`), the runner reads the fixture's Git state after a run only through the same sandbox and shell environment. The preflight checks denied reads and writes, an allowed fixture write, a staged and recorded commit in a fresh fixture repository, Git and Node startup, and a denied connection to a live loopback listener with a positive control. It stops before model calls when that boundary cannot be verified. This qualifies native command isolation, not a general hostile-plugin sandbox. Fixtures and plugin code must be trusted. Existing authentication is available to the parent CLI, outside model-tool grants; shell environments omit credentials. Effective configuration is checked for enabled MCP servers, integrations, hooks, memory, and tool network access. The fixture shell uses explicit tool paths, no Bun transpiler cache, and an empty OpenSSL configuration; these probes do not qualify application TLS behavior.

The corpus contains scoped behavior probes, not complete tracker, Herdr, browser, or release workflows. Mechanical checks cover target exposure, completed execution, file state, and required outputs. A maintainer supplies semantic judgments by reviewing the saved trace, artifacts, and each case's rubric; the runner has no automatic LLM judge. A successful process or a matching phrase alone never earns a pass. Do not put expected answers or adjudications in the readable fixture.

Reports, the harness sources, redacted traces and observations remain in the printed OS temporary directory after execution state is removed. Binary cache files are represented by size and digest, not treated as textual evidence. Symlinks are recorded without following them and block grading; capture errors preserve the trace and partial observation. The runner returns nonzero for `fail`, `blocked`, or `needs review`, and stops after a blocked model run. A passing candidate acceptance suite requires every selected condition and repetition to pass; a measured baseline failure does not fail candidate acceptance. Retain failed attempts when rerunning. Do not generalize a small observed difference into statistical proof of improvement.

To adjudicate, write a JSON array outside the fixture. Each entry names a run `id`, its `evidenceDigest` from `report.json`, a `verdict` of `pass` or `fail`, `reviewer`, `rationale`, and `evidence` references such as `candidate-handoff-neutral-1/observation.json:12`. Inspect the actual evidence against every rubric item, including shell commands that could edit and then restore a file. Each observation records the fixture's `gitStatus` and `gitCommits`, the commits made after the fixture commit with their changed paths, including commits a reset later dropped, so a claimed commit is checked against repository state. The run is graded on the file state captured before those Git reads; since Git can run configuration the model wrote, a fixture or artifact change during the reads blocks the run. The trace records only commands that started: Codex rejects a command that asks for escalated permissions under the `never` approval policy before it runs, and leaves no trace item for it. A refusal the report claims but the trace lacks therefore never ran and changed nothing. Failed or blocked mechanical checks cannot be overridden. Then run:

```sh
bun scripts/evaluate-skills.mjs --adjudicate /absolute/report/directory --reviews /absolute/reviews.json
```

This rechecks trace integrity and mechanical assertions against the matching corpus, writes a separate adjudicated report, and preserves the original. Adjudication uses the case catalogue saved with the report, rubric wording included (an older report without one needs the unchanged corpus), so a rubric corrected after the run applies only to new runs: rerun to judge with it. An empty reviews array rechecks evidence without assigning semantic passes. An incomplete run stays blocked. Deterministic evaluator controls run in CI; authenticated behavioral comparisons and native discovery run explicitly on a maintainer machine. If authentication, permissions, or the selected model is unavailable, report that gap without weakening the boundary.

#### Run native evaluation through a maintainer machine

When a worker lacks local Codex authentication, use a maintainer machine with an existing native Codex login. This still measures Codex only, not the worker's harness or operating system. Commit the candidate first; the client refuses tracked or untracked changes and requires `origin/HEAD` to identify the remote-tracking default branch.

```sh
export SUPERMATT_NATIVE_EVAL_SSH=flo@macbook
sh scripts/native-eval-remote.sh --ping
sh scripts/native-eval-remote.sh --out /absolute/new-report-directory \
  --model MODEL --baseline FULL_40_HEX_BASE_COMMIT --cases CASE_ID --runs 1 --dry-run
sh scripts/native-eval-remote.sh --out /absolute/another-new-report-directory \
  --model MODEL --baseline FULL_40_HEX_BASE_COMMIT --cases CASE_ID --runs 1
```

`--dest user@host` overrides `SUPERMATT_NATIVE_EVAL_SSH`. Choose a new `--out` for each attempt, including failed runs. The client sends a Git bundle of HEAD as `refs/heads/candidate`, excluding the remote-tracking default branch's history, and extracts the returned report even when evaluation returns nonzero. A dry run returns `plan.json`; an executed run returns the evaluator's report, traces and observations. Logs go to stderr, and the server's stdout contains only a gzip tar archive. Preserve `native-eval.json`, which records the remote hostname, trusted evaluator commit, candidate commit, baseline and exit status. Record that hostname with observed coverage; unavailable local coverage remains unobserved.

Set up the maintainer machine before granting workers access:

1. Install Git, Bun, Node >=22.13 and Codex, and authenticate Codex locally. Put their executables on the noninteractive SSH PATH, for example in `~/.local/bin`, `~/.bun/bin`, `~/.local/share/mise/shims`, `/opt/homebrew/bin`, or `/usr/local/bin`. The server does not install tools or copy credentials. Confirm `codex login status` on that machine.
2. After this support reaches the trusted origin default branch, install a reviewed, pinned copy of `scripts/native-eval-serve.sh` outside authoring checkouts, for example `/Users/flo/.local/share/harnessos/native-eval/native-eval-serve.sh`, mode `0755`. Update the installed copy only after reviewing a new revision. Enable macOS Remote Login for the intended account.
3. Create a dedicated worker SSH key. Add only its public key to the maintainer account's `~/.ssh/authorized_keys`, with this prefix and the actual absolute installed path:

   ```text
   restrict,from="100.64.0.0/10",command="/Users/flo/.local/share/harnessos/native-eval/native-eval-serve.sh" ssh-ed25519 PUBLIC_KEY native-eval
   ```

   `restrict` disables forwarding, PTYs and user RC execution. The forced command accepts only `native-eval ping` or `native-eval run --model MODEL --baseline SHA [--cases ID[,ID...]] [--runs 1..10] [--dry-run]` through `SSH_ORIGINAL_COMMAND`, with literal token validation and no shell evaluation. Do not install this key without those options or reuse a general operator key.
4. Verify the Mac's SSH host-key fingerprint locally, then pin the corresponding public host key in each worker account's `known_hosts` for the chosen SSH name. Configure its dedicated identity with `IdentitiesOnly yes`; the client uses `BatchMode=yes` and `StrictHostKeyChecking=yes`. Set `SUPERMATT_NATIVE_EVAL_SSH` in the worker harness environment.
5. In the tailnet admin policy, grant only `src = ["tag:compute"]`, `dst = ["100.67.222.13"]`, `ip = ["tcp:22"]` for this forced-command key. Review the rendered policy before applying it. The grant permits TCP SSH transport, not a general shell authorization. Run `--ping` from the worker after the operator completes setup.

The server serializes runs with a cache lock, returning 75 while another run holds it. It keeps a bare origin cache under `${XDG_CACHE_HOME:-$HOME/.cache}/supermatt-native-eval/` and removes private run directories on exit. Invalid requests return 64, invalid or unsatisfiable bundles return 65, and missing Codex login returns 69. It never changes authoring checkouts. `SUPERMATT_NATIVE_EVAL_ORIGIN_URL` replaces the fixed `https://github.com/flosrn/supermatt.git` origin only for offline tests; do not set it in production.

The evaluator and its imports run from the origin default-branch tip fetched by the server, never from the bundled candidate's JavaScript. Candidate source is Git data passed with `--repo` and `--candidate`. The candidate case catalogue is exported separately as JSON with an empty environment, Node's permission model, read access only to the candidate snapshot, no child-process, worker, addon, WASI or filesystem-write grants, and a five-second/four-MiB limit. Symlinks and non-JSON data are rejected. This permits candidate-added cases without replacing the trusted evaluator or grader; a new grading algorithm must reach the trusted default branch first.

This is not a hostile-code sandbox. [Node's permission model](https://nodejs.org/api/permissions.html) is a guardrail for trusted code, not a security guarantee against malicious code; Node 22/24 also leave network access available. The empty environment and filesystem allowlist remove ordinary access to operator credentials, but do not prove protection from a runtime bypass. Candidate skills and fixtures must remain trusted, as with local evaluation. The SSH restrictions alone do not make an untrusted boat safe to authorize against an operator account. No live Mac or tailnet changes are part of adding these scripts.


## Rules for a change

[AGENTS.md](./AGENTS.md) states what an acceptable change must satisfy. Read it before you edit a skill. It covers the skill layout, the README entry, the `ask-supermatt` router, the maintainer-controlled release policy, the Unreleased `CHANGELOG.md` entry, and the ban on em dashes.

## Open a pull request

1. Create a branch named `type/kebab-description`, such as `fix/tdd-red-check`.
2. Write commits as Conventional Commits: `type(scope): description`. Accepted types: `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`.
3. Open the pull request against `main` and fill in the template.

Pull requests are squash merged.

## Releases

Ordinary changes keep the plugin version unchanged and their changelog entries under Unreleased. Only an explicit maintainer release request starts a release. Follow the version and changelog rules in [AGENTS.md](./AGENTS.md): the Claude manifest holds the only version, and new skills or features require a minor bump.

After the release PR passes its checks and merges, the maintainer runs `sh scripts/release.sh` on a clean, up-to-date `main`. It creates and pushes the signed tag, publishes the GitHub Release from that version's changelog section, and updates the `directory` branch used by the plugin directory. `sh scripts/release.sh -n` previews the tag and notes after the release PR merges. The release projection omits the root `scripts/`, `tests/`, and `.github/` directories; bundled helpers inside `skills/` remain available. Do not edit `directory` by hand.

## Who decides

Leonid Svyatov maintains SuperMatt and is the only person who merges and releases. No successor is arranged.
