---
id: TASK-0008
title: Harden multi-session failure delivery and ownership
status: done
depends_on: [TASK-0002, TASK-0003]
priority: normal
tags: [typescript, domain, sessions, notifications, ownership, tdd]
---

# Harden multi-session failure delivery and ownership

## Problem

Polling-based responder attribution can duplicate or misroute stale failures when several Pi sessions share one watcher, interrupting an agent that is already handling the same generation.

## Context

Make one deterministic authority decide which connected session receives one terminal fresh failure. Preserve explicit pin/disconnect choices; do not infer causation from any tool call alone.

## Acceptance criteria

- [ ] Domain tests cover pinned owner, automatic owner, idle/busy owner, disconnected session, stale/superseded failure, duplicate snapshot, owner shutdown, and two-session race.
- [ ] Dedupe key includes watcher instance and generation, with failure signature only where needed.
- [ ] Only terminal fresh failures can trigger follow-up; reconnect replay does not duplicate delivered generation.
- [ ] Session already observing/verifying generation is not interrupted by redundant follow-up.
- [ ] Automatic ownership activity policy is explicit, conservative, and separate from persistence.
- [ ] Ownership/membership writes remain atomic and stale records are repaired or expire by documented policy.
- [ ] Follow-up includes compact evidence and exact next tool suggestion without unbounded logs.
- [ ] Tests prove at most one delivery under concurrent sessions/adapters.

## Notes
