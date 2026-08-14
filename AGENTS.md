# Pi Watcher extension

Pi extension that exposes Funzzy watcher state through `watcher_*` tools, `/watcher-*` commands, status bar entry, and failure follow-ups.

## Architecture route

Dependencies point inward:

```text
src/ -> application -> domain
     -> infra ------> domain
```

- `src/` is the only Pi-facing layer; `src/index.ts` is the extension entry and composition root that wires factories with concrete dependencies.
- `src/domain/` owns watcher vocabulary and deterministic policy.
- `src/application/` owns use-case orchestration through injected callbacks.
- `src/infra/` owns filesystem, Git, YAML, and Unix-socket I/O.

Read nearest nested `AGENTS.md` before changing a layer. Do not add reverse dependencies or import Pi outside `src/`.

## Public compatibility surfaces

- Tools: `watcher_status`, `watcher_targets`, `watcher_observe`, `watcher_output`, `watcher_cancel`, `watcher_verify`.
- Commands: `/watcher-status`, `/watcher-targets`, `/watcher-responder`, `/watcher-disconnect`, `/watcher-connect`.
- Status bar entry uses `watcher:` terminology and state-aware theme colors.
- Project contract is `.watch.yaml`/`.watch.yml` `on.socket`.

Do not restore deprecated `funzzy_*` or `/funzzy-*` names. Funzzy remains infrastructure product name in protocol/errors/docs.

## Task routes

- Public Pi behavior or lifecycle: start at `src/index.ts`; test registration in `src/commands.test.ts`.
- The end-to-end feedback loop: `src/e2e.test.ts` drives the real composition root against a scripted protocol server on a real Unix socket with a real git worktree — extend it when the loop contract changes.
- Stable verification behavior: change `src/application/stable-run.ts` and colocated test.
- Status/target/failure policy: change `src/domain/` and colocated tests.
- Socket, config, Git, or responder persistence: change matching `src/infra/` adapter and test.

## Proof

Use TDD and cover happy/unhappy paths. Run:

```sh
make quick  # pre-commit
make all    # complete local/CI gate
```

For package surface changes also run `npm pack --dry-run`. For interactive loading use `make try`.
