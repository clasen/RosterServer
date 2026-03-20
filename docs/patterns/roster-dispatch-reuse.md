---
id: jgoo52m5h0
type: pattern
title: 'Pattern: Reusable host dispatch internals'
created: '2026-03-20 16:17:36'
---
# Pattern: Reusable host dispatch internals

**What**: Extracted shared host routing pieces from `start()` into reusable methods (`resolveRoutedHost`, `createPortRequestDispatcher`, `createPortUpgradeDispatcher`, `prepareSites`).
**Where used**: `start()` production path and new `buildRuntimeRouter()` path.
**When to apply**: Any future feature needing Roster host routing in non-Greenlock server lifecycles or custom server ownership.
**Notes**: `register()` now supports `{ silent, skipDomainBookkeeping }` for worker-safe registration and reduced duplicate log noise.
