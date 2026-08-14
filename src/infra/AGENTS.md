# Infrastructure layer

Owns concrete external adapters used by composition root and application behavior.

## Modules and seams

- `client.ts`: JSON-RPC 2.0 over Funzzy Unix control socket; status reads and output retrieval may retry interrupted transport, run requests must not be retried after connection. `requestOutput` maps unknown generation/task RPC errors to domain errors and cancels on AbortSignal. Atomic runs read the schedule acknowledgement then a `runComplete` notification; `requestCancel` sends compare-and-cancel with generation + instance token.
- `config.ts`: reads `.watch.yaml`/`.watch.yml` and resolves `on.socket` from project root.
- `fingerprint.ts`: combines tracked Git patch and sorted untracked contents into worktree identity.
- `ownership.ts`: atomically persists automatic and pinned responder state beside socket.
- `membership.ts`: atomically persists per-session disconnect state beside socket.

## Boundaries

- May import domain types, never application orchestration or Pi runtime.
- Keep transport/storage details out of domain.
- Fail closed on malformed responses, invalid config/state, command failure, and changed worktree.
- Preserve deterministic ordering, bounded response size, timeouts, and atomic writes.

## Verification

Tests are colocated. Use temporary directories and local test sockets; always clean resources in `finally`. Cover transport success/failure, malformed data, retries, path resolution, deterministic hashes, and atomic responder behavior. Run `npm test -- --run src/infra` then `make all`.
