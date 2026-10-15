# Privacy policy

SuperMatt is a set of agent skills: Markdown instructions and a few shell and JavaScript scripts that run inside your agent (Claude Code, Codex, or a Claude app). It has no server, no account, and no telemetry. The maintainer receives no data from it, and SuperMatt itself stores nothing outside the files it writes in your working directory.

## Where your data goes

Your agent handles your conversation and code under the terms of its own provider. Beyond that, some skills pass data to tools and services you set up yourself:

- **`code-review`** hands every axis and the validation of findings to a second model as well: the `codex` CLI (OpenAI) when Claude Code runs the review, or the `claude` CLI (Anthropic) when Codex runs it. That model receives the diff under review, the spec the review checks against (an issue's text, a spec file, or the request from the session), the repository's coding standards, the findings to validate, and the review instructions, and can read the repository without changing it. The review skips this step when that CLI isn't installed.
- **`jury`** gives one seat to the `codex` CLI (OpenAI) when it is installed. That model receives the brief (the question, options, and facts) and can read the repository without changing it.
- **`to-spec`, `to-tickets`, `triage`, `wayfinder`, `implement`, `code-review`, and `orchestrate`** read or write issues on the issue tracker you choose in `setup-supermatt-skills`: GitHub through the `gh` CLI, GitLab through the `glab` CLI, or local Markdown files.
- **`ship-pr`** pushes the branch, opens a pull request, and merges it on GitHub through the `gh` CLI.
- **`babysit-pr`** pushes the branch, opens a pull request, reads its review threads, comments and checks, replies to and resolves review threads, and updates the branch on GitHub through the `gh` CLI. It never merges. **`recover-ci`** reads CI logs and reruns failed jobs on GitHub through `gh` for the skill that calls it.
- **`orchestrate`** drives worker Claude Code sessions through `herdr`, creates git worktrees for them under the repo's `.claude/worktrees/`, reads their transcripts under `~/.claude/projects`, closes and comments on GitHub issues through `gh`, and shows a macOS notification when it stops.
- **`research`** reads public web pages and documentation to answer your question.

Each of those services handles the data under its own privacy policy.

## What SuperMatt writes locally

Skills write files into your working directory when you use them: specs, tickets in a local tracker, `GLOSSARY.md`, ADRs, handoff documents, research notes, reports, and prototypes. They stay on your machine unless you commit and push them. `babysit-pr` keeps its state for each pull request under the repository's `.git/supermatt/babysit-pr/` directory, which git never commits or pushes.

## Contact

Ask about this policy in [GitHub issues](https://github.com/svyatov/supermatt/issues). For a security problem, follow [SECURITY.md](./SECURITY.md).
