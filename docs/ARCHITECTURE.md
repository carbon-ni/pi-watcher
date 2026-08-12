# Architecture

## Dependency rule

Dependencies point inward:

```text
Pi runtime
    |
    v
src/index.ts                  composition root / interface adapter
    |
    +--> src/application/     use cases and orchestration
    |          |
    |          v
    +--> src/domain/          entities, values, pure policy
    |
    +--> src/infra/           filesystem, Git, YAML, Unix socket adapters
               |
               +---- implements capabilities consumed by application/root
```

No module in `domain/` imports `application/`, `infra/`, or Pi. Application imports domain only. Infrastructure may use domain types. `src/index.ts` owns concrete wiring.

## Layers

### Domain

- `domain/watcher.ts`: watcher status and target model.
- `domain/activity.ts`: pure worktree-activity classification.
- `domain/failure-notifier.ts`: pure failure delivery policy.

### Application

- `application/stable-run.ts`: waits for requested generation and retries superseded runs only while worktree stays current.

### Infrastructure

- `infra/client.ts`: Funzzy JSON-RPC Unix socket adapter.
- `infra/config.ts`: trusted project `.watch.yaml` discovery and validation.
- `infra/fingerprint.ts`: Git/filesystem worktree fingerprint adapter.
- `infra/ownership.ts`: responder state persisted beside control socket.

### Composition root

- `index.ts`: registers Pi tools, commands, and lifecycle handlers; injects concrete callbacks into application/domain behavior.

Tests remain colocated with each layer (`*.test.ts`).

## Invariants

1. Composition root owns dependency wiring.
2. Domain stays deterministic and independent from frameworks and I/O.
3. Application receives side effects as explicit callbacks.
4. Infrastructure does not decide UI or session behavior.
5. Verification fails closed when worktree changes.
6. Polling starts on `session_start` and stops idempotently on `session_shutdown`.
7. Project configuration is read only after `ctx.isProjectTrusted()`.
8. Pi-provided APIs stay in `peerDependencies`; runtime packages belong in `dependencies`.
