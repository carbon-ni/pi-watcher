---
id: TASK-0019
title: Prove adaptive verification timeout behavior end to end
status: done
depends_on: [TASK-0018]
priority: high
tags: [integration-tests, duration, verification, compatibility, performance]
---

# Prove adaptive verification timeout behavior end to end

## Problem
Decoder and timeout selection tests do not prove a real Funzzy history survives restart, is invalidated by workflow change, and drives Pi verification without overriding explicit user bounds.

## Context

Extend real-socket/fake-clock feedback-loop proof; avoid host-duration sleeps as estimator oracle.

## Acceptance criteria

- [x] Real protocol fixture lists target estimate and `watcher_verify` chooses recommended timeout when omitted.
- [x] Explicit tool timeout wins exactly and is visible as source `explicit`.
- [x] No-history and legacy server use current fallback without decoder/progress regression.
- [x] Restart preserves estimate; workflow-signature change removes old recommendation until new samples exist.
- [x] Failed/cancelled/superseded generations do not lower later successful timeout selection.
- [x] Progress becomes `slower-than-history` after upper estimate without cancelling before selected timeout.
- [x] Typed details and compact text remain deterministic and within agent response budget.
- [x] Rust/pi-watcher golden fixtures, `make all`, and package dry run pass.
- [x] User docs explain estimate confidence, timeout precedence, state location, reset, and limitations.

## Notes

External prerequisite: Funzzy TASK-0056 black-box estimate proof.

