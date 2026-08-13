---
id: TASK-0004
title: Make watcher verification atomic and exactly targeted
status: done
depends_on: [TASK-0002]
priority: high
tags: [typescript, application, tools, verification, freshness, tdd]
---

# Make watcher verification atomic and exactly targeted

## Problem

Current stable verification selects targets by substring and retries superseded runs through client-side polling, which can run wrong work or accept a result under weaker freshness guarantees.

## Context

Replace client-side `request -> poll -> maybe retry` with one application use case consuming atomic Funzzy run-and-await. Keep Git fingerprint as independent worktree guard.

## Acceptance criteria

- [ ] Tests first cover exact target pass/fail, missing/ambiguous target, pending newer batch, supersede, watcher restart, timeout, disconnect, fingerprint change, and tool abort.
- [ ] `watcher_verify` selects exact stable target name/ID by default; substring ambiguity never silently chooses work.
- [ ] One atomic server operation returns requested generation and terminal snapshot, or explicit stale/superseded reason.
- [ ] Green is accepted only when instance is continuous, snapshot is fresh, no invalidating pending event exists, and before/after fingerprints match.
- [ ] Retry policy is explicit and bounded; extension never silently loops requesting expensive work.
- [ ] Typed details include target, instance, generation, freshness, fingerprint, outcome, and bounded failure evidence.
- [ ] Legacy polling fallback remains fail-closed and labels weaker guarantees.
- [ ] Tool help states exact selection and acceptance guarantees.

## Notes
