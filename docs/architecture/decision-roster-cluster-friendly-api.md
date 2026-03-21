---
id: n5edmg25e9
type: architecture
title: 'Architecture: Cluster-friendly init/attach API for RosterServer'
created: '2026-03-20 20:38:03'
---
# Architecture: Cluster-Friendly init/attach API

**What**: Split Roster's monolithic `start()` into `init()` (routing preparation) + optional `start()` (server lifecycle). New public methods: `init()`, `requestHandler(port?)`, `upgradeHandler(port?)`, `sniCallback()`, `attach(server, opts?)`.

**Where**: `index.js` — Roster class. Private methods: `_initSiteHandlers()`, `_createDispatcher()`, `_createUpgradeHandler()`, `_normalizeHostInput()`, `_loadCert()`, `_resolvePemsForServername()`, `_initSniResolver()`.

**Why**: `start()` assumed full ownership of bootstrap (listen, lifecycle, dispatch), conflicting with external cluster managers (sticky-session, PM2 cluster) that already own the TCP socket and distribute connections.

**Design decisions**:
- `init()` is idempotent (guarded by `_initialized` flag)
- `start()` calls `init()` internally — zero breaking changes for existing users
- SNI callback in `init()` path uses disk-based cert resolution only (no Greenlock runtime) — safe for workers
- Greenlock-backed issuance only happens in `start()` production path — reserved for the process managing certs
- `_createDispatcher` uses `this.local` to choose http/https protocol for www redirects
- `startLocalMode()` was refactored to consume pre-initialized `_sitesByPort` from `init()`
- 14 new tests added covering init/handlers/attach/sni contracts

**Key pattern for users**:
```javascript
await roster.init();
const server = https.createServer({ SNICallback: roster.sniCallback() });
roster.attach(server);
// Master passes connections — worker never calls listen()
```
