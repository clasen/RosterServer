---
id: eyap8usul0
type: decision
title: 'Decision update: autoCertificates default true'
created: '2026-03-20 23:53:16'
---
# Decision update: autoCertificates default true

**What changed**: `autoCertificates` now defaults to `true` instead of `false`.

**Why**: User expectation and product value are that SSL lifecycle should be automatic and robust by default in RosterServer.

**Implementation**:
- Constructor default changed in `index.js` (`parseBooleanFlag(options.autoCertificates, true)`).
- Added constructor tests for default true and explicit opt-out (`autoCertificates: false`).
- Updated docs (`README.md`, `skills/roster-server/SKILL.md`) to reflect default-on behavior.

**Guardrails**:
- Users can still opt out with `autoCertificates: false` when certs are externally managed.
- `ensureCertificate()` keeps explicit error message when autoCertificates is disabled.
