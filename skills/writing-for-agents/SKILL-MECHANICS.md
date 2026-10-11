# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (frontmatter, the invocation choice, and router skills). Everything else about writing it is the universal reference in `SKILL.md`.

## Invocation

Two choices, trading the two loads:

- A **model-invoked** skill keeps a `description`, so the agent can fire it autonomously, and other skills can reach it. You can still type its name: by default model-invocation _includes_ user reach, and a description only adds agent discovery. The one opt-out is Claude Code's `user-invocable: false`, for background knowledge that makes no sense as a command. The description is the skill's top-level context pointer, loaded in every session: permanent context load in exchange for discoverability. When many skills crowd the listing, hosts shorten descriptions, and Claude Code drops them for the least-invoked skills, which is why the leading word goes first. A model-invoked skill whose content is all reference is also one home for shared reference: another skill can invoke it, so reference needed by several skills lives in one place. Mechanics: omit `disable-model-invocation` and the `policy` block in `agents/openai.yaml`, and write a model-facing description carrying the trigger branches (the pointer-writing rules in `SKILL.md` apply in full).
- A **user-invoked** skill requires explicit invocation: only the human typing its name can invoke it, and no other skill can. Zero context load in Claude Code (Codex documents only that implicit invocation stops), but it spends cognitive load: you are the index that must remember it exists. Mechanics: set `disable-model-invocation: true` (Claude Code) and `policy.allow_implicit_invocation: false` in `agents/openai.yaml` (Codex); the `description` becomes human-facing: a one-line summary, trigger lists stripped.

Pick model-invocation only when the agent must reach the skill on its own, or another skill must. If it only ever fires by hand, make it user-invoked; in Claude Code, this also removes its description from context.

Shared reference that two user-invoked skills both need can live in neither: their invocation policies prevent either from firing the other. Push it to a plain file outside the skill system: external reference any skill can point at. When the skills ship in a plugin, keep that file inside the plugin root: files above it are not copied on install.

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split off a model-invoked skill when you have a distinct leading word that should trigger it on its own (a trigger word you actually use in your prompts), or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

A sequence split into its own skill hides the later steps only across a real context boundary. In Claude Code, `context: fork` gives one: the skill runs in a subagent that never sees the caller's remaining steps.

## Router skills

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. It can only suggest these skills; their invocation policies require the user to invoke them.
