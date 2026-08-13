---
id: TASK-0007
title: Propagate Pi tool abort to exact generation cancellation
status: todo
depends_on: [TASK-0004]
priority: high
tags: [typescript, tools, application, cancellation, lifecycle, tdd]
---

# Propagate Pi tool abort to exact generation cancellation

## Problem

Aborting watcher verification currently stops Pi-side polling but may leave Funzzy work and descendants running, while an imprecise cancellation could terminate replacement work.

## Context

Wire Pi AbortSignal to exact-generation cancel use case only after run identity is known. Observation-only abort must never cancel work.

## Acceptance criteria

- [ ] Tests first cover abort before schedule, during run, after terminal, during cancellation, repeated abort, superseded generation, disconnect, and cancellation timeout.
- [ ] `watcher_verify` records exact instance/generation before installing cancellation effect.
- [ ] Abort sends compare-and-cancel for exact generation; stale request cannot affect replacement/newer run.
- [ ] Tool waits a bounded interval for acknowledgement and reports graceful versus escalated/unknown cleanup.
- [ ] Pi tool returns cancellation promptly without leaving unhandled promises or listeners.
- [ ] `watcher_observe` AbortSignal only ends wait; explicit `watcher_cancel` requires generation identity.
- [ ] Cancellation domain/application policy remains independent from socket and Pi APIs.
- [ ] Integration test proves descendant process cleanup through Funzzy protocol.

## Notes
