---
id: TASK-0003
title: Replace status polling with push-driven lifecycle observation
status: todo
depends_on: [TASK-0002]
priority: high
tags: [typescript, application, infra, lifecycle, subscription, tdd]
---

# Replace status polling with push-driven lifecycle observation

## Problem

Interval polling adds latency and socket traffic and can lose transitions between reads; Pi needs one cancellable lifecycle stream or atomic long-poll with explicit reconnect state.

## Context

Replace interval `queryStatus` loop with injected observer port backed by Funzzy subscription or atomic long-poll. Keep legacy polling as capability-gated fallback only.

## Acceptance criteria

- [ ] Fake-stream tests first cover initial snapshot, transitions, duplicate sequence, disconnect, reconnect, abort, session reset, and late in-flight response.
- [ ] Only one observation operation is active per connected Pi session.
- [ ] Session start obtains immediate snapshot; subsequent UI/failure updates occur only on newer sequence/state.
- [ ] Session shutdown, disconnect command, project trust loss, and extension disposal abort observer and clear timers/listeners.
- [ ] Reconnect is bounded and does not hide stale/unavailable state; deterministic clock/random dependencies make tests reliable.
- [ ] Legacy server polling fallback is capability-gated, non-overlapping, and visibly marked weaker freshness.
- [ ] Footer and failure notifier consume normalized snapshots, not transport callbacks.
- [ ] No socket/network imports enter application or domain layers.

## Notes
