---
id: TASK-0001
title: Define Pi watcher agent feedback contract
status: todo
depends_on: []
priority: high
tags: [design, axi, domain, freshness, protocol]
---

# Define Pi watcher agent feedback contract

## Problem

pi-watcher currently reconstructs freshness and stable verification from status polling, so agent-facing tools can acquire semantics that differ from Funzzy and cannot prove an outcome belongs to latest relevant edit.

## Context

Define Pi-facing semantics before changing tools. Funzzy remains source of execution truth; extension owns acceptance, projection, session policy, and compatibility fallback.

## Acceptance criteria

- [ ] Contract maps Funzzy instance, batch, generation, task, group, terminal state, pending work, and freshness into Pi domain vocabulary.
- [ ] State/race matrix covers idle, batching, queued, running, passed, failed, cancelled, superseded, timeout, disconnect, and watcher restart.
- [ ] Defines when `watcher_verify` may accept green and when it must report stale or unknown.
- [ ] Defines exact target selection, no-match/no-op, retry, timeout, and cancellation policy.
- [ ] Defines compact content versus typed details, evidence bounds, truncation, redaction, and retrieval.
- [ ] Assigns each responsibility to domain, application, infrastructure, or Pi composition without reverse dependencies.
- [ ] Compatibility fallback for older Funzzy is explicit and labels weaker guarantees rather than pretending equivalence.
- [ ] Tool-call and response-size budgets are stated for common success and failure loops.

## Notes

Source analysis: `.tmp/reports/13-04-26/pi-watcher-agent-needs.md` in parent Funzzy workspace.
