---
id: zezv04723c
type: decision
title: 'Decision: External runtime router API'
created: '2026-03-20 16:17:36'
---
# Decision: External runtime router API

**What**: Added `buildRuntimeRouter(options)` and `prepareSites(options)` so cluster/sticky runtimes can use Roster host dispatch + VirtualServer + upgrade routing without calling `start()`.
**Where**: `index.js` (`prepareSites`, `buildRuntimeRouter`, extracted request/upgrade dispatcher helpers).
**Why**: Existing consumers had to duplicate internal `start()` dispatcher logic to integrate with externally-managed `listen()` lifecycles.
**Alternatives rejected**: Auto-starting hidden servers from `buildRuntimeRouter` (rejected to keep ownership explicit and avoid side effects).
