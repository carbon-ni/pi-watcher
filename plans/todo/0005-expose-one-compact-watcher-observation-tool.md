---
id: TASK-0005
title: Expose one compact watcher observation tool
status: todo
depends_on: [TASK-0002]
priority: high
tags: [typescript, tools, axi, status, output, tdd]
---

# Expose one compact watcher observation tool

## Problem

Agents need several calls to determine watcher freshness, pending activity, selected tasks, and failure evidence; this wastes context and increases race opportunities.

## Context

Add decision-oriented `watcher_observe` that can snapshot or atomically await. Keep `watcher_status` compatible and small rather than exposing every protocol method as Pi tool.

## Acceptance criteria

- [ ] Tool parameters support optional `afterGeneration`, `wait`, bounded timeout, update interval, and bounded failure-tail inclusion without prompts.
- [ ] Snapshot, already-terminal, wait-complete, no generation, timeout, stale, superseded, disconnected, and malformed-server paths are tested.
- [ ] Text content states state, freshness, generation, failed task, and next evidence action in compact deterministic form.
- [ ] Typed details include instance/batch/generation, changed paths, selected tasks, pending state, outcome, and truncation metadata.
- [ ] Empty/no-op state is explicit and distinguishable from transport failure.
- [ ] Progress updates are rate-bounded and emitted only when meaningful state changes or requested heartbeat interval elapses.
- [ ] AbortSignal cancels observation promptly without cancelling Funzzy generation.
- [ ] Common failure requires no second call unless bounded excerpt is insufficient.

## Notes
