# Pi Watcher extension

Pi extension that exposes Funzzy watcher state through `watcher_*` tools, `/watcher-*` commands, right-aligned widget below editor, and failure follow-ups.

## Architecture route

Dependencies point inward:

```text
src/index.ts -> application -> domain
             -> infra ------> domain
```

- `src/index.ts` is composition root and only Pi-facing production module.
- `src/domain/` owns watcher vocabulary and deterministic policy.
- `src/application/` owns use-case orchestration through injected callbacks.
- `src/infra/` owns filesystem, Git, YAML, and Unix-socket I/O.

Read nearest nested `AGENTS.md` before changing a layer. Do not add reverse dependencies or import Pi outside composition root.

## Public compatibility surfaces

- Tools: `watcher_status`, `watcher_targets`, `watcher_verify`.
- Commands: `/watcher-status`, `/watcher-targets`, `/watcher-responder`.
- Widget below editor uses `watcher:` terminology and state-aware theme colors.
- Project contract is `.watch.yaml`/`.watch.yml` `on.socket`.

Do not restore deprecated `funzzy_*` or `/funzzy-*` names. Funzzy remains infrastructure product name in protocol/errors/docs.

## Task routes

- Public Pi behavior or lifecycle: start at `src/index.ts`; test registration in `src/commands.test.ts`.
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
