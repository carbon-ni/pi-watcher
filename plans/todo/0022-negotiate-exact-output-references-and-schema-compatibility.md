---
id: TASK-0022
title: Negotiate exact output references and schema compatibility
status: doing
depends_on: [TASK-0002, TASK-0006]
priority: high
tags: [typescript, domain, capabilities, output, compatibility, tdd]
---

# Negotiate exact output references and schema compatibility

## Problem
The extension enabled watcher_output from a boolean feature while active decoder expected obsolete response shape, causing a successful server response to look like a missing task field.

## Context

Boolean output feature did not prevent old flat decoder from consuming new nested response. Negotiate concrete schema/request features before tool enablement.

## Acceptance criteria

- [x] Tests first decode supported output schema version, exact-instance requirement, request variants, paging support, and conservative byte limit.
- [x] Legacy boolean-only capability remains explicitly legacy and cannot enable advanced reference path by package-version guessing.
- [x] Unsupported/newer schema fails before output RPC with typed compatibility error, reload/upgrade action, and `doNotRetry` signal.
- [x] Domain decodes structured output reference with instance token, generation, optional exact task ID, and safe default request parameters.
- [ ] Reference rejects missing/wrong-type/empty identity, unsafe budget, unknown variant, and mismatched snapshot identity.
- [ ] Rust canonical fixtures from TASK-0079/0082 are mirrored exactly; schema drift test detects flat/nested mismatch.
- [x] Existing legacy fallback is explicit and cannot present evidence as current/exact.

## Notes

External prerequisites: Funzzy TASK-0079 and TASK-0082 fixtures.

