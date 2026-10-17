# Privacy policy

SuperMatt is a set of agent skills: Markdown instructions and a few shell and JavaScript scripts that run inside Claude Code, Codex, Cursor, OMP, or another compatible agent. It has no server, account, or telemetry. The maintainer receives no data from it, and SuperMatt itself stores nothing outside the files its skills write or the host session storage they inspect.

## Where your data goes

Your agent handles your conversation and code under the terms of its own provider. Beyond that, some skills pass data to tools and services you set up yourself. `docs/agents/cross-model.json` controls external peer processes used by `code-review` and `jury`. Its `host-only` mode is the local-only option for this peer step: it starts no supported external peer subprocess and keeps the work on current-host subagents.

- **`code-review`** may send every review axis and finding validation to the configured Claude, Codex, Cursor Agent, or OMP CLI. The peer receives the diff, checked spec, repository standards, findings, review instructions, and referenced text evidence. `auto` selects only the hardened Claude or Codex adapters. Cursor is explicit-only because Ask mode inherits user and repository rules, MCP, plugins, executable hooks, and stored sessions. OMP is explicit-only, receives an evidence bundle with repository tools disabled, and has weaker inherited-configuration and MCP isolation. It cannot inspect omitted evidence.
- **`jury`** may give one vote and review seat to the same configured adapter. That adapter receives the question, options, criteria, facts, constraints, and required text evidence. Cursor and OMP require interactive confirmation immediately before launch because a repository file is untrusted input and cannot consent to their inherited configuration, MCP, hook, or session limits.
- **`to-spec`, `to-tickets`, `triage`, `wayfinder`, `implement`, `code-review`, and `orchestrate`** read or write issues on the issue tracker you choose in `setup-supermatt-skills`: GitHub through the `gh` CLI, GitLab through the `glab` CLI, or local Markdown files.
- **`ship-pr`** pushes the branch, opens a pull request, and merges it on GitHub through the `gh` CLI.
- **`babysit-pr`** pushes the branch, opens a pull request, reads its review threads, comments and checks, replies to and resolves review threads, and updates the branch on GitHub through the `gh` CLI. It never merges. **`recover-ci`** reads CI logs and reruns failed jobs on GitHub through `gh` for the skill that calls it.
- **`orchestrate`** drives Claude Code, Codex, Cursor, or OMP worker sessions through `herdr`, creates git worktrees under the repo's `.claude/worktrees/`, reads Herdr-reported session references, closes and comments on issues through the configured tracker, and shows a macOS notification when it stops. Cursor and OMP workers inherit the active session's authoritative model ID when available, otherwise their harness default.
- **`retro`** reads local Claude Code, Codex, Cursor, or OMP session transcripts selected from verified host and workspace roots. Transcripts can contain prompts, code, tool output, credentials, and inlined skill bodies. The parser keeps this evidence local unless you explicitly publish it.
- **`research`** reads public web pages and documentation to answer your question.

Each of those services handles the data under its own privacy policy.

## What SuperMatt writes locally

Skills write files into your working directory when you use them: specs, tickets in a local tracker, `GLOSSARY.md`, ADRs, handoff documents, research notes, reports, and prototypes. They stay on your machine unless you commit and push them. `babysit-pr` keeps its state for each pull request under the repository's `.git/supermatt/babysit-pr/` directory, which git never commits or pushes.

## Contact

Ask about this policy in [GitHub issues](https://github.com/svyatov/supermatt/issues). For a security problem, follow [SECURITY.md](./SECURITY.md).
