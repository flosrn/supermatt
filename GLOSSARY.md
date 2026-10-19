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

## Relationships

- An **Issue tracker** holds many **Issues**
- A triaged **Issue** carries one category **Triage role** and one state **Triage role**
- A **Ticket** is an **Issue** (a slice of a spec)
- A **Decision ticket** is an **Issue** (a child of a `wayfinder:map`)

