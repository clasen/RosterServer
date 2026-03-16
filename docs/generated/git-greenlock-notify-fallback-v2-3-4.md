---
id: oyzcq7vmk6
type: work-log
title: Committed and pushed greenlock notify fix
created: '2026-03-16 15:55:18'
---
Created commit bfdb456 on master and pushed to origin/master. Changes: improved notify() detail-to-message normalization in index.js to handle Error objects, undefined/non-serializable inputs, and fallback to `[event] (no details)`; bumped package version to 2.3.4; added docs/generated/greenlock-notify-empty-details.md.
