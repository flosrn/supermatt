# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (role strings come from `triage-labels.md` when it exists)
- Triaged issues also carry a `Category:` line (`bug` or `enhancement`)
- Incoming reports that belong to no feature yet go in `.scratch/inbox/issues/<NN>-<slug>.md`
- Comments and conversation history append to the bottom of the file under a `## Comments` heading
- **Read an issue**: read the entire referenced file, including its fields, body, and comments.
- **List children** (implementation): enumerate every file in the parent spec's feature directory under `issues/`, never `decisions/`. Read each file and keep only tickets whose `## Parent` section contains a path or Markdown link resolving to that exact spec file. Resolve relative links from the child file's directory; mere mentions elsewhere do not establish parentage. A missing parent section in a legacy ticket is not inferred from directory proximity. A malformed/conflicting parent, duplicate ticket number, unreadable file, or incomplete directory listing must be reported; an incomplete enumeration blocks selection. Preserve each matching child's number, `Status:`, and `Closed:` fields and resolve its blockers.
- **Resolve blockers** (implementation): in a completely read child file, an omitted `Blocked by:` line means no blockers. Otherwise require a comma-separated list of ticket numbers, each resolving to exactly one `<NN>-<slug>.md` file in that same `issues/` directory. Read each referenced file, including closed tickets. Only a valid `Closed: <date>` field confirms closure under this contract; `Status: resolved` belongs to wayfinding decisions and does not close an implementation issue. Empty/malformed blocker lines, missing/duplicate targets, or unreadable files leave eligibility blocked, never zero. A child with its own valid `Closed:` field is closed regardless of its retained `Status:`; open children are ready only when `Status:` matches the configured `ready-for-agent` role. Missing, duplicate, conflicting, or unknown state fields cannot establish readiness.
- **Blocking**: a `Blocked by: NN, NN` line near the top. An issue is unblocked when every issue it lists is closed.
- **Close**: add a `Closed: <date>` line under the `Status:` line, and append the reason under `## Comments`

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed); specs use `spec.md`, implementation tickets use `issues/<NN>-<slug>.md`. Each implementation ticket sourced from a spec carries an exact `## Parent` Markdown link to that spec.

## When a skill says "fetch the issue"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket. Children live in `decisions/`, apart from the implementation issues in `issues/`, because their `Status:` line means something else.

- **Map**: `.scratch/<effort>/map.md` (the Destination / Notes / Decisions so far / Added so far / Not yet specified / Out of scope body).
- **Child ticket**: `.scratch/<effort>/decisions/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`, and `Claimed by:` identifies the owning session.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved` or closed (the Close operation above).
- **Frontier**: scan `.scratch/<effort>/decisions/` for files that are open, unblocked, and have neither `Status: claimed` nor `Claimed by:`; first by number wins.
- **Claim**: a plain file write is not exclusive acquisition. Use `/wayfinder`'s single-coordinator protocol. Only the coordinator rechecks eligibility, sets `Status: claimed` and `Claimed by: <worker-session-id>`, and saves. Read back both fields before granting that ticket to that session; the worker waits for the coordinator's grant before work.
- **Release**: only after the prior worker is confirmed stopped, the coordinator removes `Status: claimed` and `Claimed by:` together. Interrupted work remains reserved until then.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
