# Development

## Workflow

1. Start from clean branch and identify one observable behavior.
2. Add failing colocated test.
3. Implement smallest change that passes.
4. Run `make quick` before commit.
5. Use Conventional Commit message such as `feat: add greeting tool`.
6. Run `make all` before push. CI executes same command.

## Failure recovery

| Failure                         | Recovery                                                |
| ------------------------------- | ------------------------------------------------------- |
| Dependencies missing or drifted | `make setup`                                            |
| Formatting fails                | `make format-write`                                     |
| Hook not running                | `git config core.hooksPath .githooks`                   |
| Test fails                      | `npm test -- --reporter=verbose`                        |
| Coverage fails                  | add behavior-focused tests; run `make coverage`         |
| Audit fails                     | inspect `npm audit`; update lockfile deliberately       |
| Pi fails to load extension      | `pi -e ./extensions/index.ts` and inspect startup error |
| Nix metadata fails              | `nix flake show`                                        |

## Do not

- Do not put business rules in `extensions/`; Pi adapter only wires dependencies.
- Do not import external packages from `src/domain/`.
- Do not bypass failing hooks with `--no-verify`; fix gate.
- Do not add CI-only commands; expose every gate through `Makefile`.
- Do not loosen coverage threshold to land untested behavior.
- Do not start watchers, timers, or processes in extension factory; start on `session_start` and clean up on `session_shutdown`.
- Do not return unlimited tool output; use Pi truncation helpers.

## Release

Project is private starter. Before npm publication, choose package name, remove `private`, add repository/license metadata, and verify tarball with `npm pack --dry-run`.
