---
name: roster-server
description: Integrate and troubleshoot roster-server in applications using domain routing, HTTPS certificates, local HTTP, Express, Socket.IO, external servers, and graceful shutdown. Use when adding, configuring, or debugging RosterServer in a service.
---

# RosterServer integration

Use this skill to configure a consuming application. Keep its existing configuration source, module format, and process lifecycle. Check the installed package's API when version differences matter; the upstream README may describe changes not yet installed.

## Choose the lifecycle owner

- **Local development:** `new Roster({ local: true, wwwPath: absolutePath })`, register sites, then `await roster.start()`. Local mode binds to `localhost` and assigns ports; read URLs with `roster.getUrl(domain)` after startup.
- **Standalone HTTPS:** set the real `email`, absolute `wwwPath` and `greenlockStorePath`; leave `local` false. `await roster.start()` owns ACME HTTP on port 80 and the configured HTTPS listeners. A different HTTPS port does not eliminate the need for port 80.
- **External server/worker:** `await roster.init()`, then `roster.attach(server, { port })` or an HTTPS helper. The caller owns listening and closing that server. `port` on `attach()` selects the routing table, not the TCP port.
- **Serving-only worker:** use `autoCertificates: false` with `init()` and `createServingHttpsServer({ servername })`. A separate manager must provide certificates first. Calling `start()` still enables the standalone ACME lifecycle.

`init()` invokes site factories and can write certificate configuration/start renewal work; it is not a side-effect-free inspection method. Keep domains and certificate configuration consistent across workers sharing a store. The legacy `cluster: true` launcher delegates process management to Greenlock; it is separate from using Roster with an external cluster manager.

## Sites and routing

Register sites before `init()`/`start()`. Export a synchronous factory `(virtualServer) => requestHandler`; the returned `(req, res)` handler may be async. An Express app is a valid return value. Never call `app.listen()` inside the factory.

```javascript
const Roster = require('roster-server');
const path = require('node:path');

const roster = new Roster({ local: true, wwwPath: path.resolve('www') });
roster.register('example.com', () => (req, res) => res.end('Hello'));
```

- Discovery tries `index.js`, `index.mjs`, then `index.cjs`; use the module format appropriate to the application's package. Without an entry script, `index.html` enables static serving.
- `filename` changes the script basename only. `basePath` supplies default directories; it does not rebase explicitly supplied relative paths. Prefer absolute paths.
- Discovered sites stay on HTTPS **443**, even with another default `port`. Discovery replaces a manual registration for the same domain/port; distinct ports coexist.
- Manual `register('api.example.com:8443', factory)` selects that port. Exact hosts precede wildcard matches; `*.example.com` does not match the apex.
- Static serving streams files and supports HEAD and directory indexes, with strict missing-file 404s and no SPA fallback.
- Local ports are hash-based with in-instance collision handling, not OS availability detection. Do not hardcode example port numbers.
- Production `getUrl()` uses the instance's default port; it is not a per-registration custom-port lookup. A site registered only on another port can return `null`.

## Socket.IO and asynchronous requests

Attach Socket.IO to the supplied virtual server. Return the ordinary HTTP handler and register cleanup in the same factory:

```javascript
const { Server } = require('socket.io');

module.exports = (server) => {
    const io = new Server(server);
    server.onClose(() => new Promise(resolve => io.close(resolve)));
    return (req, res) => res.end('Socket.IO site');
};
```

Socket.IO wraps the request listeners and captures the returned handler as its fallback. Do not add a manual endpoint exclusion to that handler; use `io.path()` when application code needs the path. Do not use `io.opts.path`.

A virtual request listener owns its request even before it ends the response. Roster does not infer that an asynchronous listener declined the request. Thrown/rejected handler errors produce 500 or destroy an already-started response. Virtual servers share a process; they are not process isolation boundaries.

## Shutdown

- Connect `await roster.close()` to the application's existing shutdown flow. Roster does not install signal handlers or terminate processes.
- Register `virtualServer.onClose(fn)` for each site's timers, databases, and other resources. Return/await its cleanup Promise; wrap callback APIs when needed.
- Roster signals virtual `close` at shutdown start to release integrations such as long polling, closes routed WebSockets, drains HTTP, then runs cleanup hooks concurrently. Put dependent cleanup steps in one hook.
- Hooks run once. Failures are aggregated after other hooks are attempted. `closeTimeoutMs` bounds the complete operation; timeout cannot cancel arbitrary user Promises or in-flight ACME work.
- `close()` is idempotent and terminal. `init()`/`start()` share concurrent calls; startup failures clean up the instance. Create a new instance after closing or failed startup.
- For `attach()` and both HTTPS helpers, also close the caller-owned server. Roster removes its attached listeners but does not own that server's listener lifecycle. Remove manually wired dispatchers yourself.
- Coordinate each process separately; closing an instance does not stop the legacy Greenlock cluster's worker processes.

## Certificates and plugins

- Use `staging: true` for ACME test issuance when requested. `init()` alone does not bind the HTTP challenge listener.
- Wildcard certificates require DNS-01. The default CLI wrapper needs manual TXT records unless an API provider is configured; `dnsChallenge: false` disables that integration, not HTTPS.
- Linode mode uses `ROSTER_DNS_PROVIDER=linode` and `LINODE_API_KEY` from the application's secret configuration; a key also selects Linode when no provider is set. With an explicit `dnsChallenge` object, include `module: 'acme-dns-01-cli'` to select the wrapper.
- For unattended Linode operation that must fail rather than fall back to manual DNS, set `dnsChallenge.dnsApiFallbackToManual: false`. Keep other provider choices explicit.
- `combineWildcardCerts` combines apex/www/wildcard issuance using DNS-01; `disableWildcard` ignores wildcard sites. Do not enable either as a generic troubleshooting step.
- `ensureCertificate(name)` loads existing PEMs or issues missing ones; `loadCertificate(name)` only reads files. Neither means “force renewal.” File-based SNI caches detect certificate changes on supported runtimes.
- In local testing, Bun 1.3.4's `node:https` serving helper did not invoke `SNICallback`, including with the previous synchronous resolver. Do not promise SNI certificate reload merely because files changed; Node and Bun require separate runtime verification.
- Request plugins registered with `roster.use(fn)` are synchronous and run before redirects/dispatch. Return `true` only after handling the response. Promise returns produce 500.
- The optional `createScannerBlocker` comes from `roster-server/plugins/scanner-blocker.js`. Its ban state is per process and in memory. Enable `trustProxy` only when a trusted proxy overwrites `X-Forwarded-For`; `onBlock` does not itself provide shared bans.

Use the consuming application's installed README for the complete options and method signatures. The [upstream README](https://github.com/clasen/RosterServer#readme) is the project reference; prefer documentation matching the installed version.
