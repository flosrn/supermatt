# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **[single-context | multi-context]**: [one glossary at `<glossary-path>`, and ADRs in `<adr-path>` once the first one is written | a glossary map at `<map-path>` pointing to per-context glossaries].

## Before exploring, read these

- **`<glossary-path>`** for single-context repos, or
- **`<map-path>`** for multi-context repos: follow its per-context paths and read each glossary relevant to the topic.
- **`<adr-path>`**, once it exists: read ADRs that touch the area you're about to work in. In multi-context repos, also read the configured context-scoped ADR directories.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached through the grilling flows, `/triage`, `/wayfinder`, and `/improve-architecture`, or directly) creates them lazily when terms or decisions actually get resolved.

## File structure examples

These examples show the defaults. The configured paths above take precedence, including legacy or custom filenames.

Single-context repo (most repos):

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `GLOSSARY-MAP.md` at the root):

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant configured glossary. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
