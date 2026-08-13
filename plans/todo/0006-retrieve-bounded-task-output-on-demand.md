---
id: TASK-0006
title: Retrieve bounded task output on demand
status: todo
depends_on: [TASK-0002]
priority: high
tags: [typescript, tools, infra, output, diagnostics, tdd]
---

# Retrieve bounded task output on demand

## Problem

Exit status alone is not actionable, while forwarding complete logs consumes agent context; failure evidence must be compact by default and expandable by generation and task.

## Context

Add `watcher_output` backed by Funzzy retained output. It retrieves evidence; extension must not maintain second unbounded log store.

## Acceptance criteria

- [ ] Parameters require generation and optionally task, stream, tail lines, and full-retained mode with strict bounds.
- [ ] Tests cover stdout/stderr, task filtering, concurrent task identity, truncation, eviction, unknown generation/task, non-UTF8 policy, disconnect, and AbortSignal.
- [ ] Response reports observed/retained bytes or lines, truncation, eviction, and exact selected identity.
- [ ] Default response is bounded and token-conscious; `full` still cannot exceed server-retained maximum.
- [ ] Human text preserves line boundaries without ANSI or terminal-width dependence; typed details retain structured metadata.
- [ ] Protocol errors become actionable domain errors without raw stack/socket payload leakage.
- [ ] Status/observe/verify retrieval hints are copyable and appear only when evidence is truncated.
- [ ] Tool description prevents agents from using output retrieval as default status call.

## Notes
