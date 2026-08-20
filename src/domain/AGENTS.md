# Domain layer

Owns watcher vocabulary and deterministic decisions.

## Modules

- `watcher.ts`: canonical `WatcherStatus`, `WatcherTarget`, and execution states.
- `activity.ts`: decides which Pi tool calls represent worktree activity (conservative: bash/edit/write only).
- `failure-notifier.ts`: decides whether one terminal fresh failure should be delivered — owner gate, stale-freshness gate, handled-generation gate, and an atomic cross-session delivery claim for at-most-once.
- `ownership.ts`: automatic-owner activity policy (expiry TTL), separate from persistence.
- `correlation.ts`: edit-to-batch correlation policy — path normalization against the trusted root, bounded session checkpoints, and the exact/no/incomplete/unknown classifier (evidence of inclusion, never causation).
- `status-presentation.ts`: renders and colors compact user-facing watcher status.
- `observation-result.ts`: builds and formats one decision-oriented `watcher_observe` result (outcomes, evidence bounds, next-action hints).
- `output.ts`: decodes and bounds one `watcher_output` retrieval (identity, observed/retained bytes, eviction, truncation) and formats it without terminal-width dependence.
- `cancel.ts`: compare-and-cancel vocabulary (outcomes, decode, cleanup report) so a stale generation is always a safe no-op.
- `targets-presentation.ts`: renders the compact user-facing target list.
- `verification.ts`: selects exact targets, classifies terminal fingerprint/freshness acceptance, bounds evidence, and formats verification results.

## Boundaries

- No imports from `application/`, `infra/`, Pi packages, or Node built-ins in production files.
- No filesystem, clock, socket, environment, Git, or UI side effects.
- Use `watcher` in user-facing names. `Funzzy` is acceptable only when naming external product/protocol.
- Keep policies explicit and deterministic; pass needed values as arguments.

## Verification

Tests are colocated. Cover accepted and rejected decisions, including missing values and duplicate delivery. Run `npm test -- --run src/domain` then `make all`.
