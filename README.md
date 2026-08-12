# pi-watcher

[Pi](https://pi.dev) extension exposing compact Funzzy watcher status, target discovery, and stable verification.

## Start

Requirements: Node.js 24+, npm, Git, and Pi. Nix users can run `nix develop`.

```sh
make setup
make all
make try
```

`make try` loads `src/index.ts`. Configure Funzzy through project `.watch.yaml`; see [Funzzy watcher setup](docs/FUNZZY-WATCHER.md).

## One command per lifecycle stage

| Stage             | Command               | Enforcement                           |
| ----------------- | --------------------- | ------------------------------------- |
| Setup             | `make setup`          | pinned lockfile + versioned hooks     |
| During work       | `npm test -- --watch` | developer feedback loop               |
| Pre-commit        | `make quick`          | `.githooks/pre-commit`                |
| Pre-push / CI     | `make all`            | `.githooks/pre-push` + GitHub Actions |
| Manual smoke test | `make try`            | Pi loads package entrypoint           |

`make all` is definition of done: format, lint, typecheck, coverage budgets (80% statements, 85% lines, 90% functions, and 70% branches), and dependency audit must pass.

## Pi package

`package.json#pi.extensions` exposes `./src/index.ts`. During development:

```sh
pi -e .
```

For project-local installation from another repository:

```sh
pi install -l /absolute/path/to/pi-watcher
```

Pi extensions execute with full user permissions. Review code before loading package.

See [Architecture](docs/ARCHITECTURE.md) and [Development](DEVELOPMENT.md).
