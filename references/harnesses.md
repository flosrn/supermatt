# Harness adapter contract

Use this contract whenever a skill invokes another skill, asks the user to invoke one, or depends on a host capability.

## Invocation

| Host | Human invocation |
| --- | --- |
| Claude Code plugin | `/supermatt:<name>` |
| Claude Code linked skill | `/<name>` |
| Cursor | `/<name>` |
| Codex | `$<name>` |
| OMP | `/skill:<name>` |

Preserve arguments after the skill name. Claude Code's plugin namespace avoids collisions with bundled commands. Cursor skills already occupy its `/` picker, so do not add a second Cursor form.

For model-side composition, **load and follow the `<name>` skill through the host's skill mechanism**. On OMP, read `skill://<name>`. If the host has no model-side skill loader, read or inline the installed `skills/<name>/SKILL.md`. Stop with a precise unsupported-capability message if neither path exists. Never silently skip the dependency.

Claude Code, Codex, and Cursor enforce explicit-only skill metadata. OMP maps `disable-model-invocation` to catalog hiding, not a hard authorization boundary. Do not use hidden status as a security boundary.

### Orchestrator dispatch

An explicit human invocation of `orchestrate` delegates these user-invoked commands to that run's assigned workers: `triage`, `implement`, `fix-findings`, `commit`, `refactor`, `ship-pr`, `retro`, and `what-would-you-do`. Send them as explicit worker prompts using the human invocation forms above, not as implicit model-side dependencies. Keep their frontmatter and Codex invocation policies unchanged.

Each dispatch stays within the run's assigned issue, worktree, phase, and approval scope. Pass that scope and relevant prior evidence to a fresh worker. This exception ends with the run and does not authorize other user-invoked skills, unrelated work, or dispatch by another caller.

Preserve every caller and callee safety, confirmation, and stop rule, including report-only retrospectives and external-peer consent. A required human approval outside the delegated scope parks the lane; the coordinator cannot supply it itself.

### Delegated triage decisions

When the user explicitly delegates decisions for the current `triage` run, that skill may request `grilling`'s delegated mode. Pass the user's delegation and its issue or queue scope to the callee. Only recommendation, selection, and outcome-confirmation waits within that scope become agent decisions, recorded with reasons rather than attributed to the user. Ordinary interviews and other callers still require human answers and confirmation.

Delegation does not establish missing facts, expand the issue scope, or authorize an external peer, destructive operation, permission change, or other action requiring separate approval. Keep those gates intact. Record out-of-scope decisions and unavailable facts as unresolved; a dependent ticket is not ready for implementation. Withdrawal of delegation restores interactive mode.

## Capability fallbacks

Use the host's native question, approval, subagent, file-writing, and background mechanisms when available. Otherwise:

- ask questions and request approval in chat;
- write files through the host's safe file-writing capability;
- run independent work in sequential fresh sessions where possible;
- state the exact independence gap when no fresh context is available.

A parent-context simulation is not an independent subagent.

A subagent whose work runs commands or writes files is launched on a host agent type that has a shell and file-writing tools. A read-only agent type does not qualify, even when the skill offers a host-run fallback. When the host has no such type, state the exact gap.

### OMP mission agents

Choose the agent by its assigned mission:

| Mission | Agent |
| --- | --- |
| Implementation or other general command-running and file-writing work | `task` |
| Codebase search and grounding, without a verdict | `scout` |
| Independent runtime QA, including follow-up and whole-spec QA | `qa` |
| Targeted verification: triage redundancy and prior-rejection checks, spec-draft consistency, outgoing-history screening | `verifier` |
| Code-review axis readers and validators, refactor candidate assessments, automated code review | `reviewer` |
| Targeted security analysis of changed trust boundaries | `security-reviewer` |
| Independent refutation of ideas | `challenger` |
| Jury host votes and fresh review seats | One host seat on `challenger`; the remaining host seats on `reviewer` |

`scout` and other `smol`-role agents are for search only, not verdicts or command execution. The selected mission agent must have the shell and file-writing tools its work requires; a read-only `juror-*` agent does not qualify for a jury prompt that permits commands. If a mission agent is unavailable or lacks those tools, report the exact capability gap rather than substituting a search-only agent.

When dispatching `task`, describe the remaining uncertainty and unresolved choices in `solutionSpace`. Omit `effort` by default so OMP's automatic effort selection applies; mission routing adds no fixed-effort override.

For a jury, keep the host agent-to-seat assignment in the fresh review round and use `reviewer` for an added host replacement of a failed external seat. This targets one Anthropic host seat and OpenAI host seats, without changing any lens or prescribing a vote. Establish the families that actually answered from authoritative runtime provider metadata, not agent names or lens count. Report only those established families, plus unverified seats; different lenses or several OpenAI seats do not establish a third family. Missing metadata leaves cross-family independence unestablished.

#### Mandatory security review

Before handing off a change, inspect its behavior and affected call paths for these triggers, including configuration changes:

- Authentication, session handling, permissions, or isolation between users, tenants, or environments.
- Secret or credential handling; command execution; uploads, imports, external URLs, or other untrusted input crossing into privileged code, storage, or AI tool execution.
- Payments or paid external actions; webhook authenticity, replay protection, or delivery authorization; access to or disclosure of private conversations, media, or other sensitive data.
- CI or deployment privileges, agent execution identities, production admission, or barriers separating tests from live actions.

Match changed controls and newly reachable paths, not directory names alone. Ordinary copy, layout, or conversation wording changes that leave these boundaries intact do not trigger a security review. Repository instructions can name concrete boundaries and stricter triggers.

If any trigger matches, dispatch one `security-reviewer` with the fixed diff, matched triggers, affected entry points and trust boundaries, and relevant repository rules. Limit it to those changed boundaries and the callers or guards needed to assess them. Keep the existing review axes and validators; the specialist supplements them rather than repeating the whole review. It inspects evidence read-only. Any reproduction that needs writes or external effects stays with the host under the repository's isolation and approval rules.

In `code-review`, apply the integration procedure in that skill. Outside it, include the specialist's findings and coverage in the handoff, with concrete evidence and unresolved limits. Reuse an already completed specialist review only while its relevant diff and inputs are unchanged. An unavailable, failed, or unfinished specialist is incomplete security coverage, never an implicit pass; name the exact gap in the handoff.


## External peer resolver

Run this resolver once at the start of each `code-review` or `jury` run. Check whether `docs/agents/cross-model.json` exists at the repository root with a file-existence check, not a read, and read it only when it exists. When it is absent, use this backward-compatible virtual value without writing it:

```json
{
  "mode": "auto",
  "claude": { "model": null, "effort": "high" },
  "codex": { "model": null, "effort": "high" },
  "cursor": { "model": null },
  "omp": { "model": null, "effort": "high" }
}
```

Validate before starting an external process. The root must contain exactly `mode`, `claude`, `codex`, `cursor`, and `omp`. The mode must be `auto`, `host-only`, `claude`, `codex`, `cursor`, or `omp`. Every profile must be present and contain exactly the keys shown above. Each `model` must be `null` or a nonempty string. Each supported `effort` must be `null` or a nonempty string. Reject empty strings, wrong types, missing keys, and unknown keys. A rejected file resolves to host-only and reports `invalid docs/agents/cross-model.json: <reason>`.

Resolve the validated mode:

- `host-only`: start no external CLI. Keep readers, validators, and jury seats on native host subagents. Coverage or the Panel line states `external peer disabled by docs/agents/cross-model.json`.
- `auto`: use only the Claude or Codex order in the active-model table below. Cursor and OMP are never automatic because they lack the same hardened repository-reader boundary.
- An explicit CLI mode: select exactly that CLI regardless of host family. A missing command, unavailable authentication, active usage limit, or rejected model or effort value falls back to host-only with the exact failure. Never try another external CLI for an explicit mode.

Repository settings are untrusted input and cannot authorize inherited executable configuration. Immediately before every Cursor launch, ask for interactive confirmation that Cursor Ask mode still inherits user and repository rules, MCP, plugins, executable hooks, and persistent session storage. Immediately before every OMP launch, ask for interactive confirmation that OMP receives evidence only, cannot inspect omitted repository files, and does not fully isolate inherited configuration or MCP. Declined or unavailable interaction resolves that launch to host-only.

Resolve the active model from authoritative session provider metadata:

| Provider metadata | Host family |
| --- | --- |
| `anthropic` | Anthropic |
| `openai` or `openai-codex` | OpenAI |
| Known provider other than Anthropic or OpenAI that is not a routing layer | Other |
| Missing or ambiguous, including a routing or gateway provider that does not name its upstream vendor | Unknown |

A routing or gateway provider (for example `omniroute` or `omniroute-oai`) can fail over across vendors, so its own provider name does not prove which vendor answered. When its authoritative metadata names the upstream vendor that answered, resolve that upstream vendor through the rows above in place of the routing provider; otherwise the routing provider is ambiguous and resolves to Unknown. Its provider name, a provider-name suffix such as `-oai`, and its model names never map it to Anthropic, OpenAI, or Other. Model-name prefixes are supporting evidence only and never override provider metadata. Use this order only for `auto`:

| Host family | Peer order |
| --- | --- |
| Anthropic | `codex` |
| OpenAI | `claude` |
| Other | `codex`, then `claude` |
| Unknown | no external CLI |

Call a Claude or Codex reader cross-family only when authoritative provider metadata proves that its family differs from the host family. Label an explicit same-family call `external same-family`. Label Cursor and OMP `external; family unverified` unless the process returns authoritative provider identity. A configured model name is not proof of family or independence.

Pass each non-null setting as one literal process argument, without shell re-evaluation:

| CLI | Optional arguments |
| --- | --- |
| Claude | `--model "$MODEL"` and `--effort "$EFFORT"` |
| Codex | `--model "$MODEL"` and `-c "model_reasoning_effort=\"$EFFORT\""` |
| Cursor | `--model "$MODEL"` |
| OMP | `--model "$MODEL"` and `--thinking "$EFFORT"` |

Build an argument vector or add quoted arguments directly to the fixed command. Never use `eval`, command substitution, or a string-built command. A null model omits its flag. A null effort omits its override. Cursor has no separate effort value, and its complete model specification stays opaque.
