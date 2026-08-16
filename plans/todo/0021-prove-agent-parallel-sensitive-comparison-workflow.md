---
id: TASK-0021
title: Prove agent parallel-sensitive comparison workflow
status: todo
depends_on: [TASK-0020]
priority: high
tags: [integration-tests, agents, concurrency, diagnosis, compatibility]
---

# Prove agent parallel-sensitive comparison workflow

## Problem
Tool option coverage alone does not prove agent can compare parallel failure with explicit sequential exact generation while preserving freshness, timeout, evidence, and conservative diagnosis.

## Context

Use real Funzzy socket and deterministic coordination fixture; no probabilistic race test.

## Acceptance criteria

- [ ] E2E records parallel exact generation failure then explicit sequential exact generation pass for same target/profile inputs except concurrency.
- [ ] Tool details preserve both generation IDs, freshness, task outcomes, evidence bounds, timeout sources, and configured/effective concurrency.
- [ ] Presentation says `parallel-sensitive`, not proven race, and names remaining internal/external race possibilities.
- [ ] Explicit abort cancels only sequential generation and leaves no child; superseding edit is not mistaken for comparison result.
- [ ] Legacy capability fallback fails safely with actionable local command and no hidden run.
- [ ] Sequential/parallel duration profiles remain separate across watcher restart.
- [ ] Deterministic compact output stays within response budget and docs recipe matches tool schema.

## Notes

External prerequisite: Funzzy TASK-0074.

