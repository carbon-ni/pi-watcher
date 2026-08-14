---
id: TASK-0020
title: Expose sequential debugging in watcher verification
status: todo
depends_on: [TASK-0002, TASK-0004]
priority: high
tags: [typescript, tools, verification, concurrency, capabilities, tdd]
---

# Expose sequential debugging in watcher verification

## Problem
Agents cannot request Funzzy sequential comparison generation through watcher_verify, negotiate server support, or see effective concurrency in decision-oriented output.

## Context

Add optional boolean `sequential` to exact verification request/tool. Capability must be present before client sends server override.

## Acceptance criteria

- [ ] Tests first cover omitted/false/true, supported/legacy, malformed capability, timeout, cancel, supersede, and server rejection.
- [ ] `watcher_verify` input documents sequential as explicit diagnostic comparison, default false.
- [ ] Application/transport sends sequential only when true and preserves target, timeout, abort, and schedule callback.
- [ ] Capability decoder recognizes exact-generation sequential run override without package-version guessing.
- [ ] Unsupported server fails before scheduling and suggests local `fzz run TARGET --sequential`; it never silently retries parallel.
- [ ] Observation details show configured/effective concurrency and override source from server truth.
- [ ] Duration timeout selection uses sequential profile supplied by server and does not reuse parallel estimate.
- [ ] Freshness/edit correlation rules remain unchanged and sequential result cannot be presented as proof for different generation.

## Notes

External prerequisite: Funzzy TASK-0071/TASK-0073 protocol fixtures.

