# Application layer

Owns watcher use cases that coordinate domain values without choosing infrastructure.

## Main flow

`stable-run.ts` requests target generation, polls status, rejects stale worktrees, and retries superseded generations only while worktree identity remains current.

`verify.ts` owns run-and-await orchestration, bounded supersede retries, progress timers, and result assembly. Terminal fingerprint/freshness acceptance belongs to pure `domain/verification.ts`; do not duplicate it in application flow.

`observe.ts` snapshots or bounded-waits one observer port: terminal completion, explicit no-op, supersession, timeout, abort, freshness labeling, and batch correlation against the session edit checkpoint; it never triggers or cancels Funzzy work.

## Relations

- May import domain types and policies.
- Must not import `infra/`, Pi packages, or Node I/O.
- Receive requests, status reads, fingerprint checks, and similar effects as callbacks or ports.
- Return domain values or explicit application errors; do not notify UI here.

Keep timeout and supersession behavior fail-closed and deterministic under injected inputs.

## Verification

Use colocated tests with deterministic callbacks; do not open real sockets or run Git. Cover completion, supersession, stale worktree, update reporting, and timeout paths. Run `npm test -- --run src/application` then `make all`.
