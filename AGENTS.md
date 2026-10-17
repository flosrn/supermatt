Each skill is a directory directly under `skills/` (`skills/<name>/SKILL.md`), never nested deeper: Codex rejects nested skills. The plugin ships every skill in `skills/`.

Every skill must have an entry in the top-level `README.md`, under **Engineering** (daily code work) or **Productivity** (daily non-code workflow tools), that links the skill name to its `SKILL.md`. Each section groups its entries into **User-invoked** and **Model-invoked**.

Every `SKILL.md` is either user-invoked (`disable-model-invocation: true` plus `policy.allow_implicit_invocation: false` in `agents/openai.yaml`, reachable only by the human) or model-invoked (model- or user-reachable). See [.agents/invocation.md](./.agents/invocation.md).

[`ask-supermatt`](./skills/ask-supermatt/SKILL.md) is the router that maps every user-reachable skill and how they relate. The same trigger that re-syncs a docs page applies to it: whenever you add, rename, remove, or change how a user-reachable skill fits the flows, re-read `ask-supermatt`'s `SKILL.md` and update it so the map stays accurate: a new skill it never mentions, or a stale one it still routes to, is a router that lies.

Any change to a shipped skill must bump `version` in `.claude-plugin/plugin.json` (semver: PATCH for fixes, MINOR for new skills or features, MAJOR for removals or renames; before 1.0.0, a removal or rename bumps MINOR) and add a `CHANGELOG.md` entry. Plugin users get updates only on a version bump; commits without one never reach them. `plugin.json` holds the only `version`: the Claude Code catalog (`.claude-plugin/marketplace.json`) and the Codex catalog (`.agents/plugins/marketplace.json`) must not set one, and both must list the same plugins.

A version bump reaches `main` through a pull request. Once it merges, run `scripts/release.sh` on an up-to-date `main`. It creates the signed `v<version>` tag, pushes it, opens a GitHub Release from that version's `CHANGELOG.md` section, and pushes the release to the `directory` branch. The Claude plugin directory tracks that branch, which holds each release without `scripts/`, `tests/`, and `.github/`: never commit to it by hand. Whoever merges a version bump runs it right after the merge, unasked, so no merged version goes untagged. Only the maintainer's account can create `v*` tags: an agent that cannot run it (another account, a denied tool call) hands the maintainer `sh scripts/release.sh` to run instead of stopping at the merge.

Write the release notes in the version bump itself: move the Unreleased entries into a dated `## [X.Y.Z]` section of `CHANGELOG.md` and add its compare link, since that section becomes the GitHub Release notes and `scripts/release.sh` refuses a version without one.

Deprecate a user-reachable skill before you remove or rename it. Ship one release where the old name still works as a stub `SKILL.md` that names the replacement and the version that removes the stub, and list it under **Deprecated** in `CHANGELOG.md`. Remove the stub in a later release and list it under **Removed**.

The `CHANGELOG.md` Unreleased section keeps one entry per skill: fold a new change to a skill into that skill's existing entry instead of adding another line, so the changelog stays compact.

To (re)link every skill into the local harness skill directories (`~/.claude/skills`, `~/.agents/skills`), run `scripts/link-skills.sh`. Each entry is a symlink into this repo, so a `git pull` keeps installed skills current; re-run the script after adding, removing, or renaming a skill. The script only links current skills. After a removal or rename, inspect the old links and retire only confirmed stale symlinks whose targets belong to this checkout. Leave unrelated links intact; the maintainer-only linker stays unchanged.

No em-dashes anywhere in this repo's prose (`SKILL.md` files, docs, `README.md`, `CHANGELOG.md`, ADRs, changesets, code comments). Where a sentence reaches for one, rewrite it instead with a comma, colon, period, parentheses, or a conjunction, whichever the sentence actually wants; never do a blind character substitution.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `flosrn/supermatt` (the fork, not upstream). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: each of the seven triage roles uses its own name as the label. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the root, and ADRs go in `docs/adr/`. See `docs/agents/domain.md`.
