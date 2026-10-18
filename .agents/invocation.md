# Skill invocation

Every `SKILL.md` is either user-invoked or model-invoked. The shared human syntax, model-side composition, host capability fallbacks, and invocation-policy limits are defined in [`references/harnesses.md`](../references/harnesses.md).

Every skill change must preserve the contract for Claude Code, Codex, Cursor, and OMP. Check human syntax, model-side composition, capability fallbacks, explicit-only limits, and active-model family behavior even when the edited skill primarily targets one host.

## Invocation policy

- **User-invoked**: set `disable-model-invocation: true` in `SKILL.md` and `policy.allow_implicit_invocation: false` in `agents/openai.yaml`. Keep the `description` human-facing and omit trigger lists.
- **Model-invoked**: omit both fields. Keep the `description` model-facing and include the distinct triggers that justify automatic discovery.

Claude Code, Codex, and Cursor enforce explicit-only metadata. OMP hides explicit-only skills from its catalog but does not make them inaccessible to a model. Treat this as discoverability policy, not authorization.

Every skill carries `agents/openai.yaml` beside its `SKILL.md`. It holds Codex picker metadata and the paired explicit-only policy. Keep both files in sync. The top-level `README.md` groups skills into **User-invoked** and **Model-invoked**.

## Dependencies

An operative dependency says: **load and follow the `<name>` skill through the host's skill mechanism**. Preserve the named skill, arguments, order, and completion criteria. A host without a model-side loader reads the installed `SKILL.md` as specified by the harness contract. Never use a deep cross-skill file reference or silently skip a dependency.

Only model-invoked skills can normally be dependencies. The sole exception is the bounded [orchestrator dispatch contract](../references/harnesses.md#orchestrator-dispatch): an explicit human `orchestrate` invocation delegates its listed worker commands for that run without changing their invocation policies. Outside that exception, when a user-invoked skill is a precondition, tell the human to run it with the applicable form from the harness contract.

Router prose names skills for a human to choose and does not invoke them.

## Passive vs active domain work

Reading `GLOSSARY.md` for vocabulary is a prose pointer. Use `domain-modeling` only for active work: challenge terms, test edge cases, write ADRs, and update `GLOSSARY.md`.
