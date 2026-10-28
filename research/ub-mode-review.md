# Assessment of ub-mode

Borrow a few design checks, with conditional triggers. Keep the substantive guidance in its owning skill and keep `implement` focused on execution.

This is a source comparison, not an implementation or a measured evaluation of agent behavior. No shipped skills were changed.

## Evidence

Reviewed on 2026-10-28:

- Upstream: [ub-mode at 57a8bdd](https://github.com/unclebob/ub-mode/blob/57a8bdd28e45ed41900ace0bafa2ff76dd9ed70f/SKILL.md).
- Local baseline: `d55c198721048353a313da9c9b1dbbeeee8bbcf8`.
- Method: direct source inspection and a separate read-only comparison by a host subagent.

The upstream sections informing the candidates are Foundational Thinking, Boundary Discipline, Type System Discipline, Make Operations Idempotent, and Build the Lever.

## Ranked candidates

### R1: Check data contracts before implementing them

**Observation.** [implement](../skills/implement/SKILL.md), lines 21-25, moves from branch setup to test seams and verification. It has no explicit data-contract check.

[codebase-design](../skills/codebase-design/SKILL.md), line 23, includes invariants in the interface definition. Its principles and testability guidance, lines 69-105, do not explain input normalization or enforcement of valid states.

[domain-modeling](../skills/domain-modeling/SKILL.md), lines 55-67, tests domain relationships and records vocabulary. Runtime representation belongs in design guidance, not the glossary.

**Recommendation.** Add a conditional pointer in `implement` when work changes an input contract or state model. Put the actual guidance in `codebase-design`:

- Identify the accepted data shape, invalid combinations, and permitted transitions before writing the affected logic.
- Normalize and validate external data at a defined entry point.
- Prefer representations that prevent invalid combinations when they fit the language and repository conventions.
- Identify mutation ownership when concurrent callers can affect the same state.

These are proposed design checks, not requirements for new wrapper types, pure functions everywhere, or a separate architecture phase.

Preserve checks at separate trust boundaries and storage constraints needed for concurrent writers. A parsed object alone does not establish authorization or consistency.

### R2: Define duplicate and interrupted execution behavior

**Observation.** [Parallel resources](../references/parallel-resources.md), lines 3-8, governs worker resource isolation. It does not define application recovery semantics.

[Mechanical sweeps](../skills/refactor/MECHANICAL-SWEEPS.md), lines 55-56, covers repeatable transformations. [Adversarial review](../skills/code-review/ADVERSARIAL.md), lines 28-40, already examines partial writes, repeated calls, and concurrency.

**Recommendation.** Add a pre-implementation check for jobs, imports, migrations, webhooks, and retrying writes. Define what happens after duplicate delivery or interruption between effects.

Keep the design guidance in `codebase-design`, with a conditional pointer from `implement`. Add explicit duplicate-delivery and interruption scenarios to the relevant review checks.

Use the agreed interface to verify the required recovery behavior. Possible solutions include transactions, deduplication, checkpoints, or compensation, depending on the operation.

Some operations intentionally create another result on every call. Specify that contract instead of imposing idempotency on all operations.

### R3: Verify one example before a mechanical sweep

**Observation.** [Mechanical sweeps](../skills/refactor/MECHANICAL-SWEEPS.md), lines 12-36, already sizes the task and selects tooling. Lines 40-57 require follow-up inspection.

**Recommendation.** Before a broad transformation, verify one representative before/after example. Check that the automation produces that result before applying it widely.

If the sites have distinct shapes, use an example from each shape. One example does not prove the whole transformation safe.

This is a small addition to `MECHANICAL-SWEEPS.md`. It requires no new tool and no general change to `implement`.

## Existing coverage

| Topic | Local evidence | Assessment |
| --- | --- | --- |
| Small edits and single ownership of decisions | [codebase-design](../skills/codebase-design/SKILL.md), lines 35-37 and 75; [refactor](../skills/refactor/SKILL.md), lines 23-28 | Retain existing guidance. |
| Behavioral tests and mutation checks | [tdd](../skills/tdd/SKILL.md), lines 15-21 and 35-46 | More operational detail already exists. |
| Root causes and failed assumptions | [diagnosing-bugs](../skills/diagnosing-bugs/SKILL.md), lines 112-126 and 149-180 | Already requires evidence and reassessment. |
| Checked slices and small commits | [implement](../skills/implement/SKILL.md), lines 25-33 | Already enforced. |
| Shared worker resources | [Parallel resources](../references/parallel-resources.md), lines 3-8 | Already separates resources and controls ownership. |

## Exclusions

Upstream also prescribes named analysis tools, numeric thresholds, complete action logs, direct main-line pushes, and broadly worded redesign rules.

Do not import those prescriptions. Tool thresholds need evidence before becoming quality gates. Full logs add reporting work. Direct pushes conflict with the local shipping flow.

Keep the local scope controls for redesign and cleanup. Treat internal trust and compiler assertions as context-dependent engineering decisions.

## Proposed scope

Start with R1 and R2. R3 is an optional, independent refinement. Keep TDD and diagnosis unchanged.

Any implementation must preserve invocation policies, agreed test seams, and all harness fallbacks. Record changed skills under Unreleased and synchronize affected documentation.

The expected benefit is an inference from the text. No comparative agent runs were performed, so improved outcomes remain unmeasured.
