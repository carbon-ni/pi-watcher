---
id: TASK-0023
title: Retrieve watcher evidence from output references
status: todo
depends_on: [TASK-0022, TASK-0005]
priority: high
tags: [typescript, tools, output, references, axi, tdd]
---

# Retrieve watcher evidence from output references

## Problem
Agents should consume exact reference emitted by observation rather than reconstruct instance generation and tag-bearing task name from formatted prose.

## Context

Preferred tool input consumes server-provided reference. Explicit identity fields may remain advanced/compatibility surface but must satisfy same exact validation.

## Acceptance criteria

- [ ] Tool tests first pass output reference from observe/verify/status directly and assert one exact request with no display-name parsing.
- [ ] Input schema offers one obvious preferred reference path and structurally exclusive advanced request variants.
- [ ] Transport includes instance token, generation, exact task ID, safe budget/cursor, stream selection, and abort signal without dropping fields.
- [ ] Typed unknown instance/generation/task/eviction/compatibility errors format one actionable next step from structured data.
- [ ] A read-only retry occurs only for one unambiguous canonical candidate and is bounded to one; selected exact task is visible in result.
- [ ] Ambiguous/zero candidates, schema mismatch, stale reference, and `doNotRetry` never issue another RPC.
- [ ] Tool details preserve reference/continuation for subsequent page while text remains compact and deterministic.
- [ ] Failure notification/observation `nextAction` is generated from reference, not interpolated target/display name.

## Notes

External prerequisite: Funzzy TASK-0080/0082.

