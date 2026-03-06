# Lessons Learned

- When wildcard TLS must run under Bun, do not rely on manual DNS instructions; default to API-driven DNS-01 TXT creation/removal (Linode/Akamai) with propagation polling, then fall back to manual mode only when no provider token is configured.
- Do not keep speculative resolver/workaround attempts that are not the root cause; if a change does not resolve the issue with evidence, revert/simplify immediately so temporary experiments do not become permanent complexity.
- Never declare TLS/wildcard fixed based only on ACME success logs; always verify the certificate actually served to the target host with `openssl s_client` before closing the issue.
