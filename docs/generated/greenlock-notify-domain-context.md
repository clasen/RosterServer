---
id: blpic0aj8a
type: bugfix
title: 'Bugfix: Include domain in Greenlock notify logs'
created: '2026-03-16 16:25:57'
---
# Bug: Greenlock notify errors lacked domain context

**Symptom**: Timeout/certificate errors in `notify` logs did not clearly indicate which domain triggered the failure.
**Root cause**: `notify` logged only the normalized message and omitted available domain fields from Greenlock/ACME details.
**Solution**: Added domain extraction in `notify` from `subject`, `servername`, `domain`, `hostname`, `host`, `altnames`, `domains`, and `identifier.value`; prepends `[domain:<value>]` to log messages.
**Location**: index.js Greenlock `notify` callback.
