# Pi watcher agent feedback contract

Defines the semantics a Pi agent may rely on when it reads watcher state, waits on verification, selects targets, and retrieves output. Funzzy remains the source of execution truth; pi-watcher owns acceptance, projection, session policy, and compatibility fallback.

This contract is the design source for TASK-0002 through TASK-0010. Sections state the target semantics and, where the current implementation is weaker, label the guarantee explicitly. The extension never claims a guarantee the protocol does not provide.

## 1. Vocabulary

Mapping from Funzzy wire concepts to Pi domain vocabulary. Terms in **bold** are the canonical Pi domain names used in tool content and typed details.

| Funzzy concept                             | Pi domain term     | Meaning for the agent                                                                                                                                                                                    |
| ------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| watcher process serving a socket           | **instance**       | One Funzzy process. Identity = socket path + instance token. A restart is a new instance; freshness resets to unknown until first snapshot.                                                              |
| one debounce-triggered scheduling decision | **batch**          | Groups the tasks scheduled together for one trigger. Identity = batch id (when the protocol exposes it) or inferred from `generation` + `trigger` (current protocol).                                    |
| monotonic run counter per instance         | **generation**     | Strictly increasing per instance. Superseding: a newer generation is scheduled while an older one is still running or terminal. A restart may reuse numbers; never compare generations across instances. |
| named workflow                             | **task**           | One runnable unit. Wire: `name` + `commands`.                                                                                                                                                            |
| tasks scheduled by one batch               | **group**          | The task set of a batch. Current wire flattens this to `commands`; the group is the scheduled task names of the latest generation.                                                                       |
| stable outcome of a run                    | **terminal state** | `passed`, `failed`, or `cancelled`. `idle` and `running` are transitional, never terminal.                                                                                                               |
| changes not yet scheduled                  | **pending work**   | Debounced changes waiting on a batch, or queued tasks. Not observable in the current protocol; reported as `unknown` rather than guessed.                                                                |
| closeness of a snapshot to latest truth    | **freshness**      | Tiered: `current`, `stale`, `unknown`. See [§3](#3-freshness).                                                                                                                                           |

Wire fields per protocol `status`: `generation`, `state` (`idle | running | passed | failed | cancelled`), `trigger`, `commands`, `durationMs`, `failures`. `targets` yields `{name, commands}[]`. `run` yields `{runId}`.

## 2. State and race matrix

Every state an agent can observe, what it means, and what a decision tool must do with it. Tools project these states, never invent new ones.

| Situation       | Meaning                                                            | Agent reading                                                                                         |
| --------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `idle`          | No run scheduled for the latest batch.                             | Awaiting changes or final gate not yet requested. A verify request may still be made.                 |
| batching        | Debounce window open; changes seen, nothing scheduled yet.         | Treat as `pending work`; do not read as pass or fail.                                                 |
| queued          | Run scheduled, not yet started.                                    | Pending; terminal state not reached.                                                                  |
| `running`       | A generation is executing.                                         | Progress only; never accepted as outcome.                                                             |
| `passed`        | Latest observed generation completed green.                        | Green candidate; acceptance still requires freshness and instance proof ([§4](#4-verify-acceptance)). |
| `failed`        | Latest observed generation completed red.                          | Red; deliver bounded evidence, never claim unknown.                                                   |
| `cancelled`     | Run aborted before terminal pass/fail.                             | Not green, not red; report cancelled with reason when known.                                          |
| superseded      | A newer generation was scheduled before the observed one finished. | The observed outcome belongs to an obsolete run. Do not attribute it to latest relevant work.         |
| timeout         | No terminal state within the tool deadline.                        | Report `unknown` with partial evidence; never synthesize a verdict.                                   |
| disconnect      | Socket gone or unresponsive.                                       | Freshness `unknown`; fail closed (no stale pass), stop attributing activity.                          |
| watcher restart | Instance token changed between snapshots.                          | Discard cross-instance comparisons; freshness `unknown` until first snapshot of the new instance.     |

Superseded is a race, not a state: the wire keeps showing the running generation until the newer one lands. A decision tool must compare `generation` against the latest seen and against the requested run id.

## 3. Freshness

Tiered, derived, never asserted by the extension:

- **current** — observed snapshot has the latest generation for the instance, no observable pending work, instance unchanged.
- **stale** — a newer generation exists, pending work is observable, or the worktree fingerprint moved while verification ran.
- **unknown** — disconnect, restart, protocol mismatch, timeout before terminal state, or pending-work visibility not available.

Tool content states one of these three words when reporting verification or observation. `stale` and `unknown` are never rendered as green.

## 4. Verify acceptance

`watcher_verify` may accept green only when **all** hold:

1. Instance unchanged: the same instance token at request and at terminal snapshot.
2. Outcome belongs to the requested work: terminal `passed` for the requested generation, or for a superseding generation only when the worktree fingerprint is unchanged between request and acceptance.
3. Freshness current: no observable pending work at acceptance time.
4. No worktree movement: fingerprint at request equals fingerprint at terminal snapshot; any change invalidates the run (STALE).
5. Within timeout: the tool deadline was not reached (else `unknown`).

Otherwise the tool must report:

- **STALE** — fingerprint changed during verification, or the requested run was superseded and the worktree moved.
- **UNKNOWN** — instance restarted, disconnected, protocol mismatch, timed out without terminal state, or pending work visibility absent.

The extension never silently reruns to force a pass. Superseded retries are allowed only while the worktree is unchanged and are bounded ([§5](#5-target-selection-and-execution-policy)); exceeding the bound reports stale/unknown with the reason.

## 5. Target selection and execution policy

- **Exact identity by default.** Targets are matched by exact stable name. Substring or fuzzy matching only when the agent explicitly opts in; ambiguity yields an error listing compact candidates — never an arbitrary pick.
- **No-match.** Unknown target → error naming the target plus up to 5 compact candidates. Nothing is scheduled; no silent no-op.
- **No-op.** A scheduled request that produces no generation (no `runId`) is reported as no-op, not as pass.
- **Retry.** Bounded: superseded requests retry only while the worktree fingerprint is unchanged; limit is 3 consecutive superseded retries, then STALE with the superseding generation id. Requests are never retried after connection because `run` is not idempotent.
- **Timeout.** Tool deadline default 120 s, maximum 900 s. Timeout yields `unknown` with partial evidence and the last observed generation.
- **Cancellation.** Tool abort sends cancel for the exact requested generation, waits bounded (≤ 5 s) for acknowledgement, then escalates to process-group cleanup if the server has not confirmed. A replacement generation is never cancelled. Outcome reported as `cancelled` when acknowledged, else `unknown`.

## 6. Content and details

Every watcher tool returns two layers:

- **content** — compact plain text decision: state word, generation, freshness tier, and the single next action. No ANSI, no spinners, no terminal-width dependence, no raw protocol exceptions.
- **details** — typed, machine-readable evidence (identity, batches, tasks, bounds, timings). Consumed by follow-up logic and diagnostics, not required for the decision.

Evidence rules:

- **Bounds.** Failure evidence embedded in a decision is a tail: default last 4 000 chars (≤ 40 lines), configurable down, never up by the tool itself.
- **Truncation.** Truncated evidence carries an explicit marker: `…(truncated N bytes; use watcher_output)`.
- **Redaction.** Values that look like secrets or environment assignments (`TOKEN=…`, `KEY=…`, `PASSWORD=…`, `ssh-rsa …`, etc.) are replaced with `****` before content or details are emitted.
- **Retrieval.** Full retained output is fetched on demand via `watcher_output(generation, task?, tailLines?, full?)`. It reports observed bytes, retained bytes, truncation, and eviction; it never exceeds the retrieval bound ([§8](#8-budgets)).
- **Protocol failure.** Malformed or unknown payloads translate to one actionable recovery: `unknown` + which field mismatched + suggestion to restart the watcher or check the Funzzy version. A `WatcherProtocolError` is never surfaced verbatim.

## 7. Responsibility assignment

Ownership per layer, with the dependency direction `domain → application → infra → index`; nothing points outward.

| Responsibility                                                                                                                                                                                                                   | Owner                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Generations, batches, task identities, scheduling, outcomes, output retention, process-tree cancellation, protocol capabilities                                                                                                  | Funzzy server                         |
| Canonical vocabulary, freshness tiers, state projection, verify acceptance policy, target selection UX, failure dedupe/follow-up policy, worktree-session correlation, compact content projection, compatibility fallback labels | `src/domain/` (pure, no side effects) |
| Orchestration of request → wait → acceptance, retry/timeout/cancellation flow, evidence bounding                                                                                                                                 | `src/application/`                    |
| Socket connect/subscribe/reconnect, protocol decoding, fingerprinting, config discovery, responder/session persistence, redaction                                                                                                | `src/infra/`                          |
| Tool/command registration, AbortSignal wiring, status bar, trusted-project lifecycle, dependency wiring                                                                                                                          | `src/index.ts` (composition root)     |

Reverse imports are prohibited by the architecture ([ARCHITECTURE.md](ARCHITECTURE.md)).

## 8. Compatibility fallback

Older Funzzy protocol versions are handled by capability negotiation at session start (TASK-0002, the capability negotiation workstream): supported methods, fields, limits, retention, and atomic-await/subscription support are read once and cached per instance.

Fallback labels weaker guarantees explicitly — the extension never pretends equivalence:

| Capability absent           | Fallback                                                               | Freshness label       |
| --------------------------- | ---------------------------------------------------------------------- | --------------------- |
| atomic await / subscription | interval polling (current: 1 s poll) and stable-run polling (≤ 250 ms) | `polled`              |
| batch/group identity        | infer group from `generation` + `trigger`                              | `inferred`            |
| pending-work visibility     | omit pending claims                                                    | `unknown` for pending |
| output retention            | no `watcher_output`; bounded in-band tail only                         | `truncated`           |

Each degraded mode must surface its label in tool content or details, and capabilities are never assumed from package versions.

## 9. Budgets

Stated for common loops; budgets are the contract for token efficiency and latency.

| Loop                      | Tool calls                                  | Latency                                                       | Response budget                                                     |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| verify success            | 1 (`watcher_verify`) + internal run request | ≤ timeout (default 120 s)                                     | content ≤ 600 chars; details ≤ 8 KB                                 |
| verify failure            | 1 + optional 1 (`watcher_output`)           | same                                                          | content ≤ 600 chars; evidence tail ≤ 4 KB; output retrieval ≤ 64 KB |
| observe (target)          | 1 subscription, zero polling                | update on state/sequence change; progress updates ≤ 1 per 5 s | content ≤ 600 chars; details ≤ 8 KB                                 |
| status snapshot (current) | 1 poll per 1 s; socket request timeout 1 s  | ≤ 1 s                                                         | content ≤ 600 chars; details ≤ 8 KB                                 |

Total agent context cost of a common failure loop (observe + verify + output) stays under ~80 KB, dominated by the bounded output retrieval, never by polling traffic.

## 10. Trust boundary and copyable agent workflow

**Trust boundary.** Every tool requires a trusted project: `.watch.yaml`/`.watch.yml` `on.socket` inside a workspace the agent's host has explicitly trusted. Edit checkpoints normalize against that project root and never leak unrelated workspace paths; correlation is evidence of inclusion, never causation. The extension never claims a guarantee the protocol does not provide — degraded modes are labelled ([§8](#8-compatibility-fallback)), never equated.

**Copyable workflow** (the loop proven end to end in `src/e2e.test.ts`):

1. `watcher_observe` (snapshot) → record the baseline generation `G` and state.
2. Edit the worktree (edit/write results form the session checkpoint).
3. `watcher_observe(wait: true, afterGeneration: G)` → the first fresh terminal result. A `superseded` or `stale` outcome is never accepted as the fresh checkpoint; re-observe with the newer generation.
4. On `failed` with `truncated: true`, run the copyable `next` action (`watcher_output generation=N [task=X]`) for bounded evidence, apply the fix, and repeat from step 3 until the observation is fresh and green.
5. `watcher_verify(target)` accepts green only under the §4 contract (instance continuity, freshness, unchanged fingerprint) — correlation never upgrades stale green.
6. Abandoning a running verify: the tool abort sends compare-and-cancel for the exact generation (`cleanup=cancelled`); explicit `watcher_cancel(generation=N)` also works. A stale or replacement generation is a safe no-op.

Deterministic test proof: the e2e suite drives the real composition root against a scripted protocol server on a real Unix socket, with a real git worktree behind the fingerprint — every step control-driven, no sleeps, no environment mutation beyond a temp dir.
