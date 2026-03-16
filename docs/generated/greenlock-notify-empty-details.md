---
id: zskjlbshg2
type: bugfix
title: 'Bugfix: Harden Greenlock notify logging fallback'
created: '2026-03-16 15:54:09'
---
# Bug: Greenlock notify emitted unhelpful error logs

**Symptom**: Log lines such as `roster:error ----` appeared, indicating error events with missing/invalid details.
**Root cause**: `notify` used `details?.message ?? JSON.stringify(details)`, which could produce `undefined` (or throw on non-serializable data), resulting in low-signal logger output.
**Solution**: Added robust message normalization in `notify` to handle strings, `Error` instances, plain objects, and serialization failures, then fallback to `[{event}] (no details)` when empty.
**Location**: index.js notify callback inside Greenlock options.
