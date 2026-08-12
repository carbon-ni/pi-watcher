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
- compact footer status
- automatic failed-run context delivery when the agent is idle

The extension records the latest Pi session before `bash`, `edit`, and `write` calls in atomic state files beside the control socket. Each failed generation is sent once only to that responder and triggers a follow-up turn; failures detected while responder is busy are held until `agent_settled`. Funzzy remains unaware of Pi sessions.

Use `/watcher-responder claim` to pin failure handling to current Pi session. Pinned responder overrides automatic activity tracking until `/watcher-responder auto` restores it. `/watcher-responder status` shows current mode and session.

`watcher_status` accepts `wait`, `timeoutSeconds`, and `updateIntervalSeconds` (default: 5). Waiting keeps the tool call pending without blocking Pi's Node event loop; intermediate updates stay in the tool UI.

`watcher_verify` fingerprints tracked changes and untracked file contents before and after the requested run. It retries a superseded run only while fingerprint remains unchanged and rejects a pass if worktree changed during verification.

The watcher remains an independent process. Status reads retry transient connection failures and interrupted responses for request timeout, then fail closed instead of reporting stale pass. Run requests are never retried after connection because they are not idempotent.

Set `PI_FUNZZY_DEBUG=1` before starting Pi to log socket retries and recovery to stderr. Funzzy itself logs the control socket path at startup and control-triggered target names; use `fzz --log-file <path>` to preserve those logs.
