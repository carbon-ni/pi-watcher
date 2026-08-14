---
id: TASK-0017
title: Decode and present target duration estimates
status: todo
depends_on: [TASK-0011]
priority: high
tags: [typescript, domain, protocol, duration, output, tdd]
---

# Decode and present target duration estimates

## Problem
pi-watcher cannot expose server-learned runtime hints until optional estimate fields are strictly decoded and rendered compactly with confidence and sample count.

## Context

Add optional estimate vocabulary independent from transport rendering. Older Funzzy profiles omit feature/field and keep current behavior.

## Acceptance criteria

- [ ] Tests first decode absent, configured, measured, confidence levels, malformed numbers/order/source, oversized values, and unknown additive fields.
- [ ] Domain type contains typical, upper, recommended timeout, samples, confidence, and source with strict safe-integer bounds.
- [ ] Decoder rejects inconsistent ordering or impossible confidence/sample combinations defined by contract.
- [ ] Capability profile exposes `durationEstimates` and declared limits without assuming package-version parity.
- [ ] Target and correlated snapshot decoders accept optional estimate while legacy fixtures remain unchanged.
- [ ] Compact target presentation shows estimate, timeout, confidence, and sample count only when useful.
- [ ] No signature, environment data, or state path is accepted/exposed as agent detail.
- [ ] Golden fixtures match Rust protocol TASK-0055.

## Notes

External prerequisite: Funzzy TASK-0051/0055 contract and fixtures.

