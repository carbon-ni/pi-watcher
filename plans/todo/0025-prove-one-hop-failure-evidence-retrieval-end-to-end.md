---
id: TASK-0025
title: Prove one-hop failure evidence retrieval end to end
status: todo
depends_on: [TASK-0023, TASK-0024]
priority: high
tags: [integration-tests, axi, output, agents, real-watcher, reliability]
---

# Prove one-hop failure evidence retrieval end to end

## Problem
A real agent loop made eight failed calls before abandoning watcher_output; E2E must bound retrieval to one copy-safe call and fail incompatibility without retry loops.

## Context

Replay audited session failure against real Funzzy and capture registered-tool trace.

## Acceptance criteria

- [ ] Real watcher emits failure for tag-bearing/spaced job and observation contains exact reusable output reference.
- [ ] Running watcher_output with reference succeeds in first call and returns relevant bounded stderr/stdout evidence.
- [ ] Trace asserts no shortened task guess, invalid tail/full combination, schema decoder error, transport overflow, or retry permutation.
- [ ] Unknown task unambiguous candidate uses at most one read-only retry; ambiguous candidate makes zero retry.
- [ ] Watcher restart/reused generation fails exact instance check and cannot leak replacement output.
- [ ] Legacy/incompatible schema returns one `doNotRetry` compatibility result naming restart/upgrade/local CLI fallback.
- [ ] Large/multi-task output remains below Pi limit and continuation retrieves deterministic next page only on explicit call.
- [ ] Cancellation, timeout, eviction, and malformed server response keep socket/process cleanup and bounded diagnostics.
- [ ] Session-level success metric is one observation plus at most one evidence call for normal failure path.

## Notes

External prerequisites: Funzzy TASK-0083 and corresponding real-server fixtures.

