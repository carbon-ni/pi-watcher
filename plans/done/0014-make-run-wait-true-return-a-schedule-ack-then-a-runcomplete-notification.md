---
id: TASK-0014
title: Make run wait:true return a schedule ack then a runComplete notification
status: done
depends_on: [TASK-0013]
priority: high
tags: []
---

# Make run wait:true return a schedule ack then a runComplete notification

## Problem

Atomic verification needs the run identity before terminal so the tool can arm compare-and-cancel; the current run returns runId only at completion.

## Context

(Optional: approach, links, related tasks.)

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Notes
