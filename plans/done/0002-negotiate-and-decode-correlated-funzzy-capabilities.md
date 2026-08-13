---
id: TASK-0002
title: Negotiate and decode correlated Funzzy capabilities
status: done
depends_on: [TASK-0001]
priority: high
tags: [typescript, domain, infra, protocol, capabilities, tdd]
---

# Negotiate and decode correlated Funzzy capabilities

## Problem

The extension assumes one fixed control schema and cannot identify watcher restarts, feature availability, or correlation fields needed for fresh agent observations.

## Context

Add strict domain decoders and infra client methods for additive Funzzy capabilities and correlated snapshots. Cache capabilities per watcher instance, not forever by socket path.

## Acceptance criteria

- [ ] Tests first decode valid minimum/full payloads and reject malformed version, method, limit, identity, freshness, task, and batch fields with actionable errors.
- [ ] Domain types represent watcher instance and typed correlation values without importing transport or Pi APIs.
- [ ] Client requests capabilities once per instance and invalidates cache after disconnect/restart identity change.
- [ ] Supported methods, schema versions, optional fields, and output limits are exposed to application policy.
- [ ] Existing `status`, `targets`, and `run` payloads remain supported through documented compatibility decoder path.
- [ ] Missing capabilities method yields explicit legacy profile; no side-effectful feature probing.
- [ ] Response validation and size/time bounds remain in infra client.
- [ ] Golden fixtures stay synchronized with Rust protocol tests.

## Notes

External prerequisite: Funzzy agent contract/correlation/capabilities work must be available before full integration; decoder unit work can begin from agreed fixtures.
