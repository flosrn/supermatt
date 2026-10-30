# SuperMatt Skills

A collection of agent skills (slash commands and behaviors) loaded by coding agent. Skills are consumed by per-repo configuration emitted by `/setup-supermatt-skills`.

## Language

**Issue tracker**:
The tool that hosts a repo's issues: GitHub Issues, GitLab Issues, Linear, a local `.scratch/` markdown convention, or similar. Skills like `to-tickets`, `to-spec`, and `triage` read from and write to it.
_Avoid_: backlog manager, backlog backend, issue host

**Issue**:
A single tracked unit of work inside an **Issue tracker**: a bug, task, spec, or slice produced by `to-tickets`.
_Avoid_: ticket, except for a **Ticket** or a **Decision ticket** (below), or when quoting external systems that call them tickets

**Ticket**:
An **Issue** produced by `to-tickets`: one tracer-bullet slice of a spec, with its blocking edges, built by `implement` and closed only after its commits reach the default branch. Within `implement-spec`, a dependent ticket can start when its blockers' verified commits reach the integration branch, while their issues stay open until shipping.

**Decision ticket**:
A `wayfinder` unit: a child **Issue** of a `wayfinder:map` holding a *question* whose resolution is a decision, not a slice of a build to execute. The **decision** qualifier is what keeps it distinct from a **Ticket**; `wayfinder` introduces the term, then uses "ticket".

**Triage role**:
A canonical label, either a category or a state in the triage state machine, applied to an **Issue** during triage (e.g. `needs-triage`, `ready-for-agent`). Each role maps to a real label string in the **Issue tracker** via `docs/agents/triage-labels.md`.

**Tier**:
An **Issue**'s difficulty: `light` for a small, local, low-risk change; `standard` for a normal change (the default); or `heavy` for a large, cross-cutting, or risky change. A tier is separate from an issue's category and triage state.

**Full required gate**:
The checks a repository requires at a boundary: a commit, a handoff, or an integration. The repository's documentation or CI decides what they are. A repository that requires a local full suite gets one there. A repository that runs focused tests locally and broad tests in CI keeps that split, and its CI gate still has to pass before shipping. A command the repository puts behind explicit approval runs only with that approval, and invoking a skill is not that approval: without it, the command is reported as unrun coverage, never as passed. A repository that documents no gate gets the full suite plus its documented lint and type checks, and the report names what ran.
A passing result stays valid while its relevant source, dependencies, configuration, environment, and acceptance requirements are unchanged: a phase change, a report, or a commit does not invalidate it by itself. A source, dependency, configuration, or environment change invalidates the evidence it affects. Conflict resolution and runtime changes get the follow-up checks and QA they affect, and a clean rebase is not proof that every earlier result is still valid. A red, failed, timed-out, or unfinished check blocks the boundary, and its exit status is read as the command returned it, never through an output filter.
_Avoid_: full suite, for a gate the repository defines more narrowly

## Relationships

- An **Issue tracker** holds many **Issues**
- A triaged **Issue** carries one category **Triage role** and one state **Triage role**
- An **Issue** may carry one **Tier**, independently of its category and state **Triage roles**
- A **Ticket** is an **Issue** (a slice of a spec)
- A **Decision ticket** is an **Issue** (a child of a `wayfinder:map`)

