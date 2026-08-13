---
id: TASK-0009
title: Correlate successful Pi edits with watcher batches conservatively
status: todo
depends_on: [TASK-0002]
priority: normal
tags: [typescript, domain, tools, correlation, freshness, tdd]
---

# Correlate successful Pi edits with watcher batches conservatively

## Problem

A worktree fingerprint proves equality around verification but does not explain whether a watcher generation includes paths edited by this Pi session, making relevance harder to assess.

## Context

Observe eligible successful Pi file mutations and maintain bounded session edit checkpoints. Compare normalized paths with Funzzy changed-path batches; retain Git fingerprint as broader fallback.

## Acceptance criteria

- [ ] Contract states correlation is evidence of inclusion, never proof that edit caused event.
- [ ] Tests cover edit/write success/failure, multiple paths, relative/absolute paths, rename/delete, shell tools, external changes, generated files, and session reset.
- [ ] Only successful tool results create checkpoint; unsupported tools do not guess paths from prose.
- [ ] Paths normalize against trusted project root and cannot leak unrelated workspace paths.
- [ ] Checkpoints are bounded, generation/session scoped, and cleared on watcher instance change.
- [ ] Observation details classify exact overlap, no overlap, incomplete evidence, and unknown.
- [ ] Verification still requires fingerprint/freshness contract; correlation cannot upgrade stale green.
- [ ] Tool integration stays in Pi-facing layer while comparison policy remains pure domain logic.

## Notes
