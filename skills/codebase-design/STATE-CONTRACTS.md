# State contracts

Apply the sections relevant to the change. Preserve agreed behavior and repository conventions.

## Data contracts

1. Identify accepted inputs, valid states, permitted transitions, and the invariants callers rely on.
2. Locate where external data enters the module. Normalize and validate it there before passing it into business logic.
3. Prefer representations that prevent invalid combinations when they fit the language and existing design.
4. Keep authorization and storage constraints at their enforcing interfaces. Earlier parsing does not prove access rights or consistency after concurrent writes.

Use plain data when it expresses the contract clearly. Add a type or constructor only when it enforces a needed invariant.

Done when the input shape, validation owner, and permitted state transitions are explicit enough to implement and verify.

## Shared mutable state

1. Identify each mutable resource and the callers that can write it concurrently.
2. Give callers separate state when they do not need to share it.
3. For shared state, identify who may write and how conflicting writes are controlled.

Use the repository's transaction, constraint, lock, or ownership mechanism as appropriate. A check before a write must remain valid when another caller writes between them.

Done when each affected resource has an owner and a verifiable concurrency rule.

## Retries and interruption

For jobs, imports, migrations, webhooks, and retrying writes, define duplicate and interrupted execution before choosing the implementation.

1. Identify what makes two attempts the same logical operation. Distinguish a retry from an intentional new operation.
2. List durable effects and interruption points between them, including external effects.
3. Define the result of retrying after each interruption. Choose transactions, deduplication, checkpoints, or compensation only where the contract needs them.
4. Verify the agreed behavior through the public interface, including duplicate delivery and interruption after a partial write.

Use the caller's agreed test seams and verification process. Report a missing seam or unavailable failure injection instead of claiming recovery is proven.

An operation may intentionally create another result on each new request. Preserve that behavior while preventing retries from accidentally duplicating effects.

Done when repeat and recovery behavior is specified and verified, or the exact verification gap is reported to the caller.
