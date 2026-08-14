---
id: TASK-0010
title: Prove the Pi agent watcher feedback loop end to end
status: done
depends_on: [TASK-0003, TASK-0004, TASK-0005, TASK-0006, TASK-0007, TASK-0008, TASK-0009]
priority: high
tags: [integration-tests, axi, pi, reliability, performance]
---

# Prove the Pi agent watcher feedback loop end to end

## Problem

Independent tools and policies do not prove an agent can observe, edit, await fresh verification, diagnose bounded failure evidence, cancel obsolete work, and recover with few deterministic calls.

## Context

Use real Pi extension registration with deterministic fake protocol for tool contracts plus real local Funzzy socket scenarios for integration. Bound every wait and clean all listeners/processes.

## Acceptance criteria

- [ ] Green scenario observes baseline, edits, awaits exact fresh generation, and accepts verification with unchanged fingerprint.
- [ ] Failure scenario receives bounded evidence, retrieves task output, applies fix, and observes fresh recovery without parsing human logs.
- [ ] Rapid edits prove superseded result cannot be accepted for later checkpoint.
- [ ] Tool abort cancels exact generation and descendants while replacement generation remains unaffected.
- [ ] Watcher restart, capability downgrade, reconnect, timeout, ignored/no-match, malformed response, truncation, and output eviction are covered.
- [ ] Two-session scenario delivers one failure to correct owner and reconnect does not duplicate it.
- [ ] Common green loop needs at most observation plus verify, or one verify when target is known; output stays under declared byte/token budget.
- [ ] Tool schemas, descriptions, details, progress, and errors are deterministic snapshots.
- [ ] `make all`, `npm pack --dry-run`, and targeted real-extension smoke test pass.
- [ ] Docs explain guarantees, legacy fallback, trust boundary, and copyable agent workflow.

## Notes
