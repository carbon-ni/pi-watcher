# Pi Funzzy status

Reads compact test status from Funzzy's JSON-RPC 2.0 Unix control socket without adding full test output to Pi context.

## Project setup

Use one shared `.watch.yaml` for Funzzy and Pi:

```yaml
on:
  socket: .tmp/funzzy/control.sock

tasks:
  - name: final checks @agent-final
    run: cargo test
    change: ["src/**", "tests/**"]
```

Start Funzzy from project root:

```bash
fzz --log-file .tmp/funzzy/tests.log
```

Pi reads `on.socket` directly from `.watch.yaml` (or `.watch.yml`).

The extension adds:

- `watcher_status` agent tool; `wait: true` awaits active generation and emits periodic updates
- `watcher_targets` agent tool for discovering target names and commands
- `watcher_verify` final-gate tool (defaults to target `@agent-final`)
- `/watcher-status`, `/watcher-targets`, and `/watcher-responder` commands
- `/watcher-disconnect` and `/watcher-connect` commands to opt a Pi session in/out of watcher delivery
- compact, colored watcher status right-aligned below editor
- automatic failed-run context delivery when the agent is idle

The extension records the latest Pi session before `bash`, `edit`, and `write` calls in atomic state files beside the control socket. Each failed generation is sent once only to that responder and triggers a follow-up turn; failures detected while responder is busy are held until `agent_settled`. Funzzy remains unaware of Pi sessions.

Use `/watcher-responder claim` to pin failure handling to current Pi session. Pinned responder overrides automatic activity tracking until `/watcher-responder auto` restores it. `/watcher-responder status` shows current mode and session.

The extension observes watcher state through a push-driven lifecycle: one cancellable observation stream per connected Pi session, fed either by Funzzy's subscription snapshots (when negotiated capabilities support them) or by a non-overlapping status poll as the capability-gated legacy fallback. Legacy polling is visibly marked with a `(polled)` suffix in the status bar because its freshness guarantee is weaker than a subscription. The observer reconnects with bounded exponential backoff after transport drops, reports `watcher: unavailable` instead of hiding stale state, and is aborted on session shutdown, `/watcher-disconnect`, trust loss, or extension disposal.

Run `/watcher-disconnect` to opt the current Pi session out of the watcher: observation, the status bar entry, and activity attribution stop, so the session never becomes the responder and receives no watcher messages. If that session holds the pinned responder, the pin is released so other sessions can take over. The choice is persisted per project beside the socket and survives session restarts; `/watcher-connect` re-joins the session to the watcher.

`watcher_status` accepts `wait`, `timeoutSeconds`, and `updateIntervalSeconds` (default: 5). Waiting keeps the tool call pending without blocking Pi's Node event loop; intermediate updates stay in the tool UI.

`watcher_verify` selects targets by exact name by default — substring ambiguity returns candidates instead of running work — and runs one atomic verification: it fingerprints tracked changes and untracked file contents before and after the run, accepts green only when the watcher instance is continuous, the snapshot is fresh, no newer batch is pending, and the fingerprints match, and retries a superseded run only while the fingerprint is unchanged and only a bounded number of times. On the legacy polling path it labels outcomes `polled` instead of pretending atomic guarantees.

The watcher remains an independent process. Status reads retry transient connection failures and interrupted responses for request timeout, then fail closed instead of reporting stale pass. Run requests are never retried after connection because they are not idempotent.

Set `PI_FUNZZY_DEBUG=1` before starting Pi to log socket retries and recovery to stderr. Funzzy itself logs the control socket path at startup and control-triggered target names; use `fzz --log-file <path>` to preserve those logs.
