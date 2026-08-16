---
id: TASK-0024
title: Enforce transport-safe output request variants
status: todo
depends_on: [TASK-0022, TASK-0023]
priority: high
tags: [typescript, tools, output, pagination, bounds, axi]
---

# Enforce transport-safe output request variants

## Problem
Current tool schema allows rejected full plus tail combinations and full output can exceed Pi transport, encouraging repeated parameter permutations.

## Context

Keep response below Pi transport with envelope margin. Do not advertise `full` as safe when server retention exceeds tool response cap.

## Acceptance criteria

- [ ] TypeBox schema makes tail request and page/continuation request mutually exclusive; invalid combination cannot reach execute.
- [ ] Preferred defaults use server reference budget clamped below Pi maximum and reject zero/oversized values.
- [ ] Decoder validates returned/retained/observed bytes, truncation, continuation, task/stream identity, and response-reference correlation.
- [ ] Formatter applies secondary deterministic content budget without losing continuation/truncation notice.
- [ ] Pagination follows opaque cursor exactly and detects repeated cursor/no progress to prevent loops.
- [ ] `full` compatibility input is removed or mapped to bounded first page per negotiated contract; no call can produce >64KB tool result.
- [ ] Tests cover multibyte UTF-8, one huge line, many tasks/streams, empty output, exact boundary, cancellation, and eviction between pages.
- [ ] Prompt guidance says retrieve another page only when needed; repeated unchanged failed requests are forbidden.

## Notes

External prerequisite: Funzzy TASK-0081.

