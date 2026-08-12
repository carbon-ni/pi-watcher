# Architecture

## Dependency direction

```text
Pi runtime -> extensions/ -> src/domain/
                            -> src/lib/
                            -> src/infra/
```

- `extensions/`: composition root and Pi adapters. Register tools, commands, and events here.
- `src/domain/`: deterministic business rules. No Pi, filesystem, network, process, or third-party imports.
- `src/lib/`: reusable project-owned utilities without infrastructure policy.
- `src/infra/`: adapters for filesystem, network, processes, and external services.
- `src/cli/`: optional standalone executable adapters.
- `src/fixtures/`: test fixture files.

Tests are colocated with implementation (`*.test.ts`). Empty folders document intended boundaries and can disappear until needed.

## Rules

1. Composition root owns dependency wiring.
2. Domain depends on values or explicit interfaces, never infrastructure.
3. Infrastructure implements domain-facing interfaces.
4. External dependency access belongs in `src/infra/` unless package is Pi adapter API used by `extensions/`.
5. Start long-lived resources on `session_start`; close them idempotently on `session_shutdown`.
6. Runtime dependencies must be pinned under `dependencies`; Pi-provided APIs remain `peerDependencies`.

## Configuration

Use one JSON configuration file if configuration becomes necessary. Resolve it in this order:

```text
defaults < project config < environment variables
```

Use Pi `CONFIG_DIR_NAME`; do not hardcode `.pi`. Read project configuration only when `ctx.isProjectTrusted()` is true. Validate once at adapter boundary and pass typed values inward.
