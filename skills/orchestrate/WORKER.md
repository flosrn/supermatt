# Worker

Claude Code sessions use these models and efforts:

| Session | Phases | Model | Effort |
|---|---|---|---|
| V | verify | `opus` | `xhigh` |
| T | triage | `opus` | `high` |
| A | implement, the QA and review restarts in [step 3](SKILL.md#3-check-the-worker), fix | `sonnet` | `high` |
| B | refactor, ship | `opus` | `high` |
| C | retro | `opus` | `high` |

Codex sessions use these models and reasoning efforts:

| Session | Phases | Model | Effort |
|---|---|---|---|
| V | verify | `gpt-6-astra` | `high` |
| T | triage | `gpt-6-astra` | `high` |
| A | implement, QA restart in [step 3](SKILL.md#3-check-the-worker) | `gpt-6.1-sol` | `medium` |
| A | review restart in [step 3](SKILL.md#3-check-the-worker), fix | `gpt-6-astra` | `high` |
| B | refactor, ship | `gpt-6-astra` | `high` |
| C | retro | `gpt-6-astra` | `high` |

For Cursor, read the current session's authoritative model ID into ACTIVE_MODEL and pass that exact ID to every new worker. If authoritative metadata does not expose it, omit `--model` and record that the harness default is inherited. Never infer a model from provider family. Cursor receives no effort flag.

OMP sessions use these models and efforts (OMP thinking), every one through the OmniRoute gateway. Code written on Sol is reviewed on Claude, so the review reads it from another model family:

| Session | Phases | Model | Thinking |
|---|---|---|---|
| V | verify | `omniroute/opus-5.5` | `high` |
| T | triage | `omniroute/opus-5.5` | `high` |
| A | implement, QA restart in [step 3](SKILL.md#3-check-the-worker) | `omniroute-oai/sol-6.1` | `medium` |
| A | review restart in [step 3](SKILL.md#3-check-the-worker), fix | `omniroute/opus-5.5` | `high` |
| B | refactor, ship | `omniroute-oai/sol-6.1` | `high` |
| C | retro | `omniroute/opus-5.5` | `high` |

Select the Claude, Codex, or OMP row for every launch and restart. In Codex, Cursor, and OMP, defer the review inside `/implement` to the fresh review worker in [step 3](SKILL.md#3-check-the-worker), so it runs on the review row's model. If findings reach [step 4](SKILL.md#4-fix-findings) from a Sol worker, restart on the fix row before prompting `/fix-findings`; include each finding's full text, prior reports and checked commits, and the issue reference, since the fresh session has no record of them.

For OMP, pass each row's handle as MODEL exactly as written, never a bare model name or the native `openai-codex` provider: native `openai-codex` rotates every ChatGPT account logged into OMP, including the one reserved for GitHub PR reviews, while the gateway serves Codex from the workers' account only. A bare `--model gpt-6.1-sol` resolves to the native provider. If the gateway handle does not resolve or answer, the launch failed: park the lane rather than fall back to another model.

For OMP, resolve OMP_WORKER_CONFIG to the absolute path of [omp-worker.yml](omp-worker.yml) beside this skill, not relative to WT. This read-only launch overlay disables configured auto-resume without changing user or project settings. A missing or invalid overlay is a launch failure. `--no-prewalk` prevents an automatic model handoff from overriding the phase model. Retain normal skill discovery and permission controls; add no auto-approval, resume, or continue flags.

## Dispatch preamble

Every instruction prompt in this skill and its linked procedures goes through **Send the prompt** below, including V, T, implementation, QA/review/fix restarts, refactor, commit, conflict recovery, ship/repair, retro, status questions, retries, and answers. Launching a process alone supplies no task context.

Before sending, build DISPATCH from the lane's current state, substituting actual values:

```text
This worker is assigned by the user's explicit orchestrate invocation.
Assigned issue/spec: <REF and DISPLAY>.
Worktree: <absolute WT>; code and Git operations stay here.
Phase: <current phase and session letter>.
Approval scope: <the user's actual delegated actions and restrictions for this phase>.
Use only orchestrate's delegated commands and model-invoked dependencies. Preserve the called skills' safety and mandatory human-consent gates. Stop and report any action outside this scope; the coordinator cannot supply separate human consent.
Resources and tracker: <current resource ownership; tracker configuration; for local Markdown, the absolute paths and ownership rules from LOCAL.md>.
Prior evidence: <relevant handoffs, decisions, unresolved questions, full findings and QA/review reports with checked commits and retained artifact paths, plus intervening changes>.
Recovery history: <attempts, outcomes, remaining limits, and shipping record when applicable>.
```

Use explicit `none yet` only when no prior evidence or recovery history exists. Missing evidence is `unavailable: <reason>`, never a clean result. Include enough source evidence in the prompt or readable absolute artifact paths for a fresh context to continue without relying on another session's memory. A retry or restart keeps the same decisions, findings, and recovery budget. Set the approval scope from the user's authorization and the current phase, not from a worker recommendation or the mere fact that an action stays inside WT. Verification and retro are read-only; any later authorized tracker-writing phase receives its own updated scope.

**Send the prompt**: translate the task's skill command using KIND and [Skill notation](SKILL.md#skill-notation). Put the complete task text in TASK and the populated shared preamble in DISPATCH, then send:

```sh
herdr agent prompt "$WORKER" "$TASK

$DISPATCH" --wait
```

Keep the explicit skill command at the beginning of TASK so the host recognizes it. All shorter prompt recipes below and in the linked procedures are TASK bodies, never complete prompts. Native `/exit` is the sole exception and is sent unchanged. Rebuild DISPATCH for each send, including after a fresh launch, changed phase, retry, or context-clearing dialog. Pass values as quoted data, not shell-evaluated command strings.

- **Start the worker**: run `herdr pane run PANE "cd WT"` with WT shell-quoted, then use the matching recipe. Claude: `herdr agent start "$WORKER" --kind claude --pane "$PANE" -- --model "$MODEL" --effort "$EFFORT"`. Codex: `herdr agent start "$WORKER" --kind codex --pane "$PANE" -- --model "$MODEL" -c "model_reasoning_effort=$EFFORT"`. Cursor: `herdr agent start "$WORKER" --kind cursor --pane "$PANE" --` plus `--model "$ACTIVE_MODEL"` only when known. OMP: `herdr agent start "$WORKER" --kind omp --pane "$PANE" -- --model "$MODEL" --thinking "$THINKING" --no-prewalk --config "$OMP_WORKER_CONFIG"`, with MODEL and THINKING from the current phase row. Shell-quote every substituted path and value. Then run `herdr pane report-metadata PANE --source orchestrate --display-agent "worker L"`. If `agent start` returns `agent_pane_busy` or says the name is in use, wait three seconds and retry up to five times. If it returns `agent_not_ready`, answer the visible startup dialog.
- **Stop the worker**: read `herdr agent get WORKER` `.result.agent.agent_session`. Retain every Herdr-reported session ID or path in SESSIONS. A `kind: path` value must be absolute and is retained directly. For Claude and Codex IDs, also retain the transcript path under SESSION_ROOT when found. For Cursor, never manufacture a transcript path from an ID. Capture evidence before `herdr agent prompt WORKER "/exit"`. The pane and recorded transcripts remain.
- **Restart the worker**: stop it and confirm its harness process has exited, then start it. Use a fresh launch, not `/restart`.
- **Show phase P**: at the start of each phase in the [Loop](SKILL.md#loop), set the lane's phase to `DISPLAY P` and run `herdr tab rename "$HERDR_TAB_ID" "<each busy lane's phase, joined by ' | '>"`.
- **Wait for the worker**: run every `herdr agent prompt ... --wait` as a background command, so the other lanes go on meanwhile. When it returns, run `herdr agent wait WORKER --until idle --until done --until blocked` in the background and let it notify you. The wait can return `done` between two turns while sub-agents are still running, so then run `sleep 15` and `herdr agent get WORKER`: if it is `working`, wait for the worker again. If the worker is `blocked`, [answer the dialog](ANSWER.md#answer-a-dialog) and wait for the worker again.
- **Read the worker's reply**: check its current state with `herdr agent get WORKER`. Use `herdr agent read WORKER --source visible --lines <n>` while it is working, blocked, or unknown; use `--source recent-unwrapped` for history only after it settles at idle or done. Capturing alternate-screen history can require scrolling, which Herdr refuses while a worker is active. If a history read returns `agent_not_idle` because the state changed, read with `--source visible` and continue; this read-mode mismatch is recoverable and does not park the lane.
  After an OMP worker's first completed turn, require `.result.agent.agent_session` with `kind: path` and an absolute value, then retain it in SESSIONS. After a Cursor worker's first completed turn, require an authoritative Herdr session ID or path; a path must be absolute. A missing or invalid reference parks the lane with the exact evidence gap. Session creation is lazy, so do not require a reference before the first turn.
  If the pane does not show the reply, read a reported `kind: path` transcript directly. Otherwise locate only Claude or Codex IDs under SESSION_ROOT: Claude Code uses `<session>.jsonl`; Codex rollout filenames include the session ID in dated subdirectories. For OMP, take the last assistant text from `type: "message"` records with `message.role: "assistant"`, joining only text content blocks and skipping thinking, tool calls, and the physical title record. For a Cursor ID without a path, do not derive storage during orchestration. When no matching readable transcript exists, ask the idle worker to write its last reply to a temporary file and return the path.