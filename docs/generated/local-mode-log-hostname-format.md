---
id: fralm92cih
type: bugfix
title: 'Bugfix: local mode startup logs show subdomain.localhost'
created: '2026-03-16 17:19:26'
---
# Bug: local mode startup logs ignored subdomain localhost format

**Symptom**: Startup logs still printed `http://localhost:<port>` for subdomains (e.g. `api.example.com`) even after local URL behavior changed.
**Root cause**: `startLocalMode()` log message used a hardcoded `localhost` string.
**Solution**: Added `localHostForDomain(domain)` helper and reused it in both `getUrl()` and local-mode startup logs so they stay consistent.
**Location**: `index.js` (`localHostForDomain`, `getUrl`, `startLocalMode` listen log).
