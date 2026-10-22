# Triage Labels

The skills speak in terms of seven canonical triage roles (two category roles and five state roles) and three separate tier roles for per-issue difficulty. This file maps those roles to the actual label strings used in this repo's issue tracker. Tier roles are not triage roles: `/triage` neither sets nor reads them, and its state machine stays unchanged.

| Label in supermatt | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `bug`                      | `bug`                | Something is broken                      |
| `enhancement`              | `enhancement`        | New feature or improvement               |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| `tier:light`               | `tier:light`         | Small, local, low-risk change            |
| `tier:standard`            | `tier:standard`      | Normal change, the default               |
| `tier:heavy`               | `tier:heavy`         | Large, cross-cutting, or risky change    |

When a skill mentions a role (e.g. "apply the `ready-for-agent` triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.
