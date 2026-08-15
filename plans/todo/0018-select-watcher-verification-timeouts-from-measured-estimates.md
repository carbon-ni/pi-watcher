---
id: TASK-0018
title: Select watcher verification timeouts from measured estimates
status: doing
depends_on: [TASK-0017]
priority: high
tags: [typescript, application, verification, timeout, axi, tdd]
---

# Select watcher verification timeouts from measured estimates

## Problem
watcher_verify uses caller or fixed fallback timeout even when server has target-specific history, causing unnecessary early timeout or excessively long waits.

## Context

Create pure timeout selection result carrying milliseconds and source. Tool remains non-interactive and explicit caller timeout always wins.

## Acceptance criteria

- [ ] Tests first cover explicit, measured, configured, default, unsupported capability, malformed estimate, cap, and zero-history paths.
- [ ] Precedence is explicit tool argument, measured recommendation, configured hint/default, then current 120-second fallback.
- [ ] Selection returns source `explicit|measured|configured|default` and chosen estimate metadata for typed details.
- [ ] `watcher_verify` discovers exact target before choosing timeout and uses same target identity for run request.
- [ ] Client/server absolute bound is enforced without silently extending explicit timeout.
- [ ] Progress reports elapsed, typical, upper, selected timeout, and `slower-than-history` after upper; never predicts remaining time or declares stuck.
- [ ] Estimate cannot upgrade freshness, retry superseded work, or convert timeout into cancellation unless existing explicit policy does.
- [ ] Legacy server behavior remains current bounded fallback and is labeled by timeout source.

## Notes

