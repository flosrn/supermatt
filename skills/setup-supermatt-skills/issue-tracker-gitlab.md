# Issue tracker: GitLab

Issues and specs for this repo live as GitLab issues. Use the [`glab`](https://gitlab.com/gitlab-org/cli) CLI for all operations.

## Conventions

- **Create an issue**: `glab issue create --title "..." --description "..."`. Use a heredoc for multi-line descriptions. Pass `--description -` to open an editor.
- **Read an issue**: `glab issue view <number> -F json` for issue details, then `glab api projects/:id/issues/<number>/notes --paginate` for all notes. Both outputs are machine-readable JSON; consume every notes page, including newer comments.
- **List issues**: `glab issue list --output json` with appropriate `--label` filters. Fetch successive `--page` values starting at 1 until a successful response contains an empty JSON array, then combine the pages before filtering or deciding no issues match. A failed command is an error, not the end of the list.
- **List children** (implementation): use **List issues** without label filters to fetch every open issue page, then read each candidate's complete description. Keep only issues whose `## Parent` section contains exactly the requested parent reference. Resolve project and issue identity; `#12` does not match `#123`, another project's issue, `Part of` wayfinding links, or a mention elsewhere in the description. Preserve each child's `iid`, state, labels, and description; a malformed or conflicting parent declaration is unknown, not a match. Use **Resolve blockers** for each child. Incomplete pagination or a failed read is not proof that no child exists.
- **Resolve blockers**: use the procedure below; there is no assumed numeric blocker count.
- **Comment on an issue**: `glab issue note <number> --message "..."`. GitLab calls comments "notes".
- **Apply / remove labels**: `glab issue update <number> --label "..."` / `--unlabel "..."`. Multiple labels can be comma-separated or by repeating the flag.
- **Close**: `glab issue close <number>`. `glab issue close` does not accept a closing comment, so post the explanation first with `glab issue note <number> --message "..."`, then close.
- **Merge requests**: GitLab calls PRs "merge requests". Use `glab mr create`, `glab mr view`, `glab mr note`, etc., the same shape as `gh pr ...` with `mr` in place of `pr` and `note`/`--message` in place of `comment`/`--body`.

Infer the repo from `git remote -v`; `glab` does this automatically when run inside a clone.

## Merge requests as a triage surface

**MRs as a request surface: no.** _(Set to `yes` if this repo treats external merge requests as feature requests; `/triage` reads this flag.)_

When set to `yes`, MRs run through the same labels and states as issues, using the `glab mr` equivalents:

- **Read an MR**: `glab mr view <number> -F json` for details, `glab api projects/:id/merge_requests/<number>/notes --paginate` for all notes, and `glab mr diff <number>` for the diff. Consume every notes page.
- **List external MRs for triage**: fetch every page of `glab mr list -F json` using the **List issues** pagination procedure. Before filtering, fetch all unfiltered pages of `glab api projects/:id/members/all --paginate` and retain each member's `id` and effective `access_level`; this includes inherited and invited memberships. Match every MR's author ID against those results: members at any role are internal. Treat an absent author as external only when pagination is complete and the authenticated caller is a project member, establishing visibility of invited private-group members. A failed or partial membership lookup, missing author ID or role, or unproven membership visibility makes classification unknown, not external; report that coverage gap. See the [project membership API](https://docs.gitlab.com/api/project_members/#list-all-members-of-a-project).
- **Comment / label / close**: `glab mr note`, `glab mr update --label`/`--unlabel`, `glab mr close`.

Unlike GitHub, GitLab numbers issues and MRs separately, so `#42` is unambiguous once you know which surface the maintainer means.

## When a skill says "publish to the issue tracker"

Create a GitLab issue.

## When a skill says "fetch the issue"

Run both commands under **Read an issue** above to fetch the details and all notes.

## Resolving implementation blockers

Where native blocking is available, fetch all pages of `glab api projects/:id/issues/<iid>/links --paginate`. In the linked-issue results, `link_type: is_blocked_by` identifies blockers of this child; `blocks` points in the other direction and `relates_to` is not blocking. Read each blocker at its returned `project_id` and `iid` (`glab api projects/<project_id>/issues/<iid>`), including issues outside the current project. Only `state: closed` satisfies a blocker; `opened` blocks. Missing state, unknown link types, inaccessible links/issues, or an incomplete response leave eligibility unknown. The API filters links by authorization; do not claim a complete native blocker set when access to dependencies cannot be established.

Also inspect any top-level `Blocked by:` line in the full description, including when native links are present. Where native blocking is known unavailable, this is the fallback. Resolve every listed reference to its project and issue, fetch it even if it is closed, and require every blocker to be closed. An omitted line in a completely read fallback description declares no textual blockers; an empty/malformed line or an unresolved/unreadable blocker is unknown, not zero. A native request failure does not establish that native blocking is unavailable. The child is eligible only when both applicable native and textual blockers are satisfied.

API reference: [GitLab issue links](https://docs.gitlab.com/api/issue_links/). The REST field is `is_blocked_by`, not the `/blocked_by` quick-action spelling.

## Wayfinding operations

Used by `/wayfinder`; `/to-tickets` uses **Blocking** too. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Destination / Notes / Decisions so far / Added so far / Not yet specified / Out of scope body. `glab issue create --label wayfinder:map`. (On GitLab tiers with native epics, an epic may hold the map instead; a labelled issue works everywhere.)
- **Child ticket**: an issue carrying `Part of #<map>` at the top of its description and labels `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitLab's **native blocking link**, the canonical, UI-visible representation. Add it with the `/blocked_by #<n>` quick action, posted as a note (`glab issue note <child> --message "/blocked_by #<blocker>"`). Native blocking links are a Premium/Ultimate feature; on the free tier (or where unavailable) fall back to a `Blocked by: #<n>, #<n>` line at the top of the description. A ticket is unblocked when every blocker is closed.
- **Frontier query**: use **List issues** to fetch every page, then scope the combined results to the map's children and drop any with an open or unresolved blocker using **Resolve blockers**, or an assignee or unreleased claim note; first in map order wins.
- **Claim**: assignment is not exclusive acquisition. Use `/wayfinder`'s single-coordinator protocol. Only the coordinator rechecks eligibility and writes `glab issue note <n> --message "Claimed by: <worker-session-id>"`, then `glab issue update <n> --assignee <worker-login>`. Read back both writes before granting that ticket to that session. An unreleased claim note reserves the ticket even if assignment failed; the worker waits for the coordinator's grant before work.
- **Release**: only after the prior worker is confirmed stopped, the coordinator removes the assignee and appends `Claim released: <worker-session-id>` with **Comment on an issue**. Claims without a matching later release remain active until the ticket closes.
- **Resolve**: `glab issue note <n> --message "<answer>"`, then `glab issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
