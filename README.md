# 👾 RosterServer

Host multiple domains behind one Node.js entry point, with HTTPS certificates managed through Greenlock, Express and Socket.IO integration, static file serving, and local HTTP development. Each site receives a virtual server for request and upgrade listeners. By default every site directory runs in its own process, so a busy, blocked, or crashed site does not take the others down; see [site isolation](#site-isolation).

## Installation

```sh
pnpm add roster-server
```

`npm install roster-server` and `bun add roster-server` are also supported installation commands. The package exports a CommonJS constructor that can also be imported as an ESM default. Server examples below use `.mjs`; site examples use `.cjs`.

## Quick start: local HTTP

Save as `server.mjs` and run `node server.mjs` from your application directory:

```javascript
import path from 'node:path';
import Roster from 'roster-server';

const roster = new Roster({
    local: true,
    wwwPath: path.resolve('www')
});

roster.register('example.com', () => (req, res) => res.end('Hello'));
await roster.start();
console.log(roster.getUrl('example.com'));
```

Local mode binds to `localhost`, skips certificates, and assigns domain ports within `minLocalPort`–`maxLocalPort` (default `4000`–`9999`). Assignments use a domain hash and resolve collisions within the instance; they do not probe for available OS ports. A bind failure rejects startup. Read the assigned URL with `getUrl()` instead of hardcoding a sample port.

For production HTTPS, use a real contact email, public DNS pointing to the host, and explicit storage paths:

```javascript
import Roster from 'roster-server';

const roster = new Roster({
    email: 'admin@example.com',
    wwwPath: '/srv/www',
    greenlockStorePath: '/srv/greenlock.d'
});

await roster.start();
```

Standalone HTTPS opens port `80` for ACME challenges in addition to the configured HTTPS ports. Port `80` cannot be a production site port. Use `staging: true` when testing certificate issuance; staging certificates are not publicly trusted.

## Sites and routing

```text
www/
├── example.com/index.cjs
├── api.example.com/index.mjs
├── static.example.com/index.html
└── *.example.com/index.cjs
```

For each directory, discovery checks `index.js`, `index.mjs`, then `index.cjs`. If none exists, `index.html` enables static serving. `filename` changes the script basename; the static entry remains `index.html`. Match `.js` exports to the site's package module type, or use `.cjs`/`.mjs` explicitly.

Discovery happens during `init()`. Register manual sites before initialization. Discovered sites use HTTPS port **443**, even when the instance's `port` is different; a discovered registration replaces a manual registration for the same domain and port. Loading new sites requires a new instance or process restart.

### Site factory contract

Export a **synchronous factory** `(virtualServer) => requestHandler`. The returned `(req, res)` handler may be asynchronous. Return an Express app directly; do not call `app.listen()` inside a factory.

Basic site, saved as `www/example.com/index.cjs`:

```javascript
module.exports = () => async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Hello');
};
```

Express site, with Express installed in the consuming application:

```javascript
const express = require('express');

module.exports = () => {
    const app = express();
    app.get('/', (req, res) => res.json({ ok: true }));
    return app;
};
```

The virtual server supports request/upgrade listener integration; it is not a separately listening TCP server. Process isolation comes from [site isolation](#site-isolation), not from the virtual server. Request listeners own their requests, including asynchronous responses. Roster does not invoke the returned handler just because a listener has not finished. Wrappers can capture the site's HTTP fallback through `server.listeners('request')`.

Thrown or rejected request-handler errors produce a `500`, or destroy the response if headers were already sent.

### Socket.IO and resource cleanup

With Socket.IO installed in the consuming application:

```javascript
const { Server } = require('socket.io');

module.exports = (server) => {
    const io = new Server(server);
    io.on('connection', socket => {
        socket.on('chat:message', message => io.emit('chat:message', message));
    });
    server.onClose(() => new Promise(resolve => io.close(resolve)));

    return (req, res) => res.end('Socket.IO site');
};
```

Socket.IO handles its own endpoint and delegates other requests to the returned handler. No manual path exclusion is required. Use the public `io.path()` method if application code needs its configured path.

### Manual registration and custom ports

After creating `roster`, register factories before `init()` or `start()`:

```javascript
const site = () => (req, res) => res.end('API');
roster.register('api.example.com', site);
roster.register('api.example.com:8443', site);
roster.register('*.example.com:8443', site);
```

Instead of a factory, `register()` also accepts a site directory, loaded like a discovered site. A directory registration can run in an isolated process, and every domain registered with the same directory, including the discovered one, shares that process:

```javascript
roster.register('en.example.com', path.join(wwwPath, 'example.com'));
```

A registration without an explicit port uses the instance's `port`. Exact hosts take precedence over wildcard matches. `*.example.com` does not match the apex `example.com`; register the apex separately if needed. Wildcard certificates require [DNS-01 configuration](#certificates-and-dns).

Requests to `www` hosts redirect to the host without `www`, preserving the explicit port in the Host header. `getUrl(domain)` normalizes `www` and supports wildcard lookups. In local mode it returns `localhost` or a subdomain such as `api.localhost`, with the assigned port. In production it uses the instance's default port; it is not a per-port URL lookup for registrations made only on non-default ports, which can return `null`.

### Static sites

A directory with `index.html` and no entry script needs no JavaScript factory:

- `GET` streams the requested file; `HEAD` reads metadata without reading the body.
- `/` and directory requests serve the corresponding `index.html`.
- Missing files return `404`; there is no SPA fallback. Unsupported methods return `405`.
- Paths that resolve outside the site root are rejected. Content type is inferred from the file extension.

Filesystem operations are asynchronous, and disconnected downloads close their file handles.

## Site isolation

`start()` runs each site directory in its own Node.js process. This applies to discovered `www/` sites and to directories passed to `register()`. One process serves every domain and port registered with that directory, so a site with SQLite, files written by lowdb, cron jobs, or internal servers never runs twice. Disable isolation with `isolation: false`.

The main process keeps the listeners, certificate issuance and renewal (ACME, SNI, wildcard), port 80, and shutdown. For each HTTPS connection it reads only the TLS ClientHello and passes the raw socket to the process serving that SNI host. That process terminates TLS and handles requests, WebSocket upgrades, request plugins, and `onClose` hooks. The socket is the client's own connection, so `req.socket.remoteAddress` and all headers arrive unchanged. A TLS handshake does not use the main process's CPU or event loop. In local mode, each isolated process listens on its own assigned port.

These sites stay in the main process:

- A factory function passed to `register()`, because a function cannot move to another process. Register the site directory instead to isolate it.
- A site whose entry module the main process already loaded with `require()`. Isolating it would create a second instance. This check cannot see ESM modules imported by the application; do not import an isolated site's module from the server script.
- Connections without SNI, or for a host no isolated site serves.

Roster logs the sites that are not isolated at startup.

A crashed isolated process is restarted after `isolation.restartDelayMs`, and the other sites keep serving. While it is down, its connections are refused. If its startup fails, `start()` rejects, as it does for an in-process factory error. Once more than `isolation.backlog` connections are waiting for a site process, new connections to that site are dropped. A client that sends no ClientHello within `isolation.helloTimeoutMs` is disconnected.

```javascript
const roster = new Roster({
    isolation: { restartDelayMs: 1000, backlog: 511, helloTimeoutMs: 10000 }
});
```

When at least one site is isolated, request plugins added with `use()` before `start()` are recreated in every isolated process. Plugin state, such as scanner-blocker bans, is therefore per site. A plugin can be recreated only if it carries a `Roster.pluginSource` descriptor whose options are JSON-serializable; otherwise `start()` rejects. `createScannerBlocker()` provides one unless its options include functions such as `onBlock`. For a custom plugin:

```javascript
// my-plugin.cjs
const Roster = require('roster-server');

function createMyPlugin(options) {
    const plugin = (req, res, context) => false;
    plugin[Roster.pluginSource] = { module: __filename, export: 'createMyPlugin', options };
    return plugin;
}

module.exports = { createMyPlugin };
```

On `close()`, or a handled signal, each isolated process drains its requests, runs its `onClose` hooks, and exits. Hook errors from those processes appear in the same `AggregateError`. When `closeTimeoutMs` expires, Roster kills the remaining isolated processes. Isolated processes ignore `SIGINT` and `SIGTERM` and wait for the main process, so a signal sent to the whole process group by a terminal or process manager does not cut their drain short. If the main process exits without closing, each isolated process closes itself.

Isolation needs a Roster-owned listener, so it applies only when `start()` initializes the instance. Calling `init()` yourself keeps every site in the current process for `attach()` and the other external-server helpers. Isolation is not available on Bun, whose HTTPS server cannot adopt a passed socket; there, Roster logs a warning and serves every site in the main process. Isolation cannot be combined with the legacy `cluster: true` launcher, which disables it by default.

Each isolated process loads Node.js and its site, so memory use grows with the number of site directories. Code that runs when a site's module loads runs in that site's process, not in the main process.

## Startup and shutdown

Concurrent `init()` calls share initialization, so each factory runs once per registered domain/port. Concurrent `start()` calls share startup. In standalone and local modes, `await roster.start()` waits for listeners to bind. Initialization or bind failures reject and clean up resources already initialized by the instance.

Register `virtualServer.onClose(fn)` in a factory for timers, databases, queues, or other site-owned resources. Hooks may return Promises, run once, and run concurrently after active HTTP requests drain. Put dependent cleanup operations in the same async hook. This is separate from the virtual server's `close` event, which is emitted when shutdown begins so integrations can release long polling requests.

`await roster.close()`:

1. Stops accepting work and cancels Roster's renewal/retry timers.
2. Closes listeners opened by `start()`, including ACME HTTP, and routed WebSockets; drains active HTTP requests and waits for pending certificate work.
3. Runs site cleanup hooks. Individual failures do not prevent other hooks from running; failures are reported in an `AggregateError`.

`closeTimeoutMs` (default `30000`) bounds the whole operation. At the deadline Roster destroys remaining owned connections and active routed responses, attempts cleanup hooks, and rejects with a timeout. It cannot forcibly interrupt an application Promise or an ACME operation already in progress.

Closing is **idempotent and terminal**: repeated calls return the same Promise. Create a new instance after closure or failed initialization/startup.

For automatic shutdown on `SIGINT` or `SIGTERM`, explicitly enable `handleSignals`:

```javascript
const roster = new Roster({ handleSignals: true });
await roster.start();
```

The option defaults to `false`. Listeners are installed once when `init()` or `start()` begins and removed when closure completes, including failed startup or cleanup. Signals call `roster.close()`; repeated signals during closure do not repeat cleanup. Existing application signal listeners remain installed. Shutdown failures are logged and set `process.exitCode = 1`.

Roster does not force process termination or close caller-owned servers. The process exits naturally when its remaining work finishes; other resources or cluster workers still require application coordination. If the application already coordinates shutdown, leave `handleSignals` disabled and connect Roster to that flow:

```javascript
async function shutdown() {
    try {
        await roster.close();
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
```

## External servers and workers

Use `init()` when your application or cluster manager owns the listener. It loads sites and invokes factories without binding ports. In production, it also generates certificate configuration and, unless `autoCertificates: false`, creates the certificate runtime and renewal timer.

A serving-only worker with existing certificates:

```javascript
import Roster from 'roster-server';

const roster = new Roster({
    email: 'admin@example.com',
    wwwPath: '/srv/www',
    greenlockStorePath: '/srv/greenlock.d',
    autoCertificates: false
});

await roster.init();
const server = await roster.createServingHttpsServer({ servername: 'example.com' });
server.listen(8443);
```

The caller owns this server's listen/error/close lifecycle. To wire an existing HTTP(S) server instead, call `roster.attach(server, { port: 443 })`. The `port` selects a routing table; it does not change the server's listening port. Attach request handling only where Roster should own dispatch. Repeating the same attachment is a no-op; attaching that server to a different routing port throws.

During shutdown, `roster.close()` drains its routed requests, closes its routed upgraded sockets, and removes only listeners added by `attach()`. It **does not close the external server**, including servers returned by the HTTPS helpers. Coordinate both closures in the owning application. Manually wired `requestHandler()`/`upgradeHandler()` listeners must also be removed by their owner.

For multiple workers, keep certificate issuance in one manager process and use `autoCertificates: false` with `init()` in serving workers. The manager can use `start()` to provide ACME HTTP and `ensureCertificate()` before starting workers. Keep domain/certificate configuration consistent: `init()` still writes configuration even in serving-only mode. `start()` retains the standalone ACME lifecycle even if `autoCertificates` is false.

The legacy `cluster: true` launcher delegates process management to Greenlock and turns off [site isolation](#site-isolation). `close()` applies to the current Roster instance; it does not stop worker processes. External cluster managers should coordinate shutdown in each worker.

## Certificates and DNS

The default DNS-01 integration is a wrapper around `acme-dns-01-cli`, with `propagationDelay: 120000`, `autoContinue: false`, and `dryRunDelay` matching propagation delay. Without an API provider, DNS challenges require manual TXT records. `dnsChallenge: false` disables this integration, not HTTPS itself.

Wildcard sites normally receive a separate wildcard certificate using DNS-01; apex/www use their regular certificate flow. `combineWildcardCerts: true` puts apex, www, and wildcard names on the primary certificate and requires DNS-01. `disableWildcard: true` ignores wildcard site registrations and discovery.

For Linode, supply `LINODE_API_KEY` through the application's secret configuration and set `ROSTER_DNS_PROVIDER=linode`. A configured Linode key also selects that provider when no provider is specified. The wrapper creates/removes TXT records and checks DNS propagation. API failures can fall back to manual mode by default; for unattended operation that must fail instead, configure:

```javascript
const dnsChallenge = {
    module: 'acme-dns-01-cli',
    provider: 'linode',
    dnsApiFallbackToManual: false
};
```

Pass this as the constructor's `dnsChallenge` option. To use another provider, install its Greenlock DNS plugin in the consuming application and supply its module name and provider options. Configure DNS timing on that object with `propagationDelay`, `dryRunDelay`, `dnsPollIntervalMs`, and `dnsPollTimeoutMs`; the wrapper's polling interval defaults to `15000` ms.

New certificates use an `EC-P256` key by default, which makes each full TLS handshake much cheaper for the server than an RSA key. Clients that cannot negotiate ECDSA, such as Windows XP or Android 2.x, need `serverKeyType: 'RSA-2048'`. The key type applies to certificates issued after it is set: renewal reuses a certificate's existing key, so certificates issued before 3.2.0 keep their RSA key. To move an existing name to the configured key type, remove its directory under `greenlockStorePath/live/` and restart; Roster issues a new certificate on the first connection for that name.

Roster's file-based SNI resolvers cache TLS contexts and detect changed certificate files through metadata, including updates from another process. Concurrent requests for the same certificate name share loads and checks. Standalone startup reuses the initialized certificate runtime and Roster's cancellable renewal loop. Loading an existing certificate does not itself force renewal.

## Configuration reference

Pass operational settings through the constructor, using the consuming application's configuration source. Prefer absolute `wwwPath` and `greenlockStorePath`. `basePath` supplies their defaults; it does not rebase explicitly supplied relative paths.

| Option | Default | Meaning |
| --- | --- | --- |
| `email` | `admin@example.com` | Replace with the real certificate contact. |
| `basePath` | Derived from package location | Default parent for `www` and `greenlock.d`; set explicitly when relying on it. |
| `wwwPath` | `basePath/www` | Discovered sites. |
| `greenlockStorePath` | `basePath/greenlock.d` | Certificate files and generated configuration. |
| `filename` | `index` | Script entry basename, without extension. |
| `local` | `false` | Local HTTP mode with assigned ports and no certificates. |
| `port` | `443` | Default port for manual registrations and routing helpers. |
| `hostname` | `::` | Production bind address; local mode uses `localhost`. |
| `minLocalPort`, `maxLocalPort` | `4000`, `9999` | Inclusive local assignment range. |
| `staging` | `false` | ACME staging environment. |
| `autoCertificates` | `true` | Certificate runtime during `init()`; disable for serving-only workers. |
| `certificateRenewIntervalMs` | `43200000` (12h) | Roster renewal check interval; minimum `60000`. |
| `closeTimeoutMs` | `30000` | Positive finite total shutdown deadline. |
| `handleSignals` | `false` | Close this instance on `SIGINT`/`SIGTERM`; does not force process exit. |
| `isolation` | `true` (`false` with `cluster`) | One process per site directory under `start()`; `false` or `{ restartDelayMs, backlog, helloTimeoutMs }` (defaults `1000`, `511`, `10000`). See [site isolation](#site-isolation). |
| `tlsMinVersion`, `tlsMaxVersion` | `TLSv1.2`, `TLSv1.3` | Protocol limits for created HTTPS servers. |
| `keepAliveTimeoutMs` | Node.js default (`5000`) | Idle time before a site server closes a keep-alive connection, in isolated and main-process sites. Set it above the interval at which clients repeat requests so they reuse the connection instead of paying a new TLS handshake. |
| `serverKeyType` | `EC-P256` | Key for newly issued certificates: `EC-P256`, `EC-P384`, `RSA-2048`, `RSA-3072`, or `RSA-4096`. See [certificates](#certificates-and-dns). |
| `skipLocalCheck` | `true` | Skips Greenlock dry-run/local challenge checks. |
| `dnsChallenge` | CLI wrapper | DNS-01 options or `false`; see [certificates](#certificates-and-dns). |
| `disableWildcard`, `combineWildcardCerts` | `false`, `false` | Wildcard registration and certificate behavior. |
| `cluster` | `false` | Legacy Greenlock-managed cluster launcher. |

## API reference

| Method | Contract |
| --- | --- |
| `register(domain, factory \| siteDirectory)` | Register before initialization; accepts `domain:port` and wildcard domains. A site directory can be isolated; a factory runs in the main process. Returns `Roster`. |
| `use(plugin)` | Add a synchronous request plugin. Returns `Roster`. |
| `init()` | `Promise<Roster>`; prepare routing and factories without listening. |
| `start()` | Start standalone/local listeners; await readiness. |
| `close()` | `Promise<void>`; drain and clean up the instance. |
| `getUrl(domain)` | URL or `null`; local assignment is available after startup. See [routing](#manual-registration-and-custom-ports) for port limitations. |
| `requestHandler(port?)` | HTTP dispatcher for the selected routing port. Requires `init()`. |
| `upgradeHandler(port?)` | WebSocket upgrade dispatcher. Requires `init()`. |
| `attach(server, { port }?)` | Add both dispatchers to a caller-owned server. Requires `init()`; returns `Roster`. |
| `sniCallback()` | TLS SNI callback. Requires production-mode `init()`. |
| `ensureCertificate(servername)` | `Promise<{ key, cert }>`; load existing PEMs or issue missing ones when enabled. Requires production-mode `init()`. |
| `loadCertificate(servername)` | Synchronously load `{ key, cert }` without issuance. Requires production-mode `init()`. |
| `createManagedHttpsServer({ servername, port?, ensureCertificate?, tlsOptions? })` | `Promise<https.Server>` with certificates and dispatchers; does not listen. Certificate assurance defaults to `true`. Requires production-mode `init()`. |
| `createServingHttpsServer({ servername, port?, tlsOptions? })` | Same helper with `ensureCertificate: false`; set `autoCertificates: false` for a serving-only instance. |
| `virtualServer.onClose(fn)` | Register a cleanup hook; returns the virtual server. See [shutdown](#startup-and-shutdown). |
| `Roster.pluginSource` | Symbol for a request plugin's `{ module, export, options }` descriptor. See [site isolation](#site-isolation). |

## Request plugins

Plugins run before redirects and site dispatch. They receive `(req, res, { host, domain })`; return `true` after handling the response, or `false`/`undefined` to continue. Plugins must be synchronous. Thrown errors or Promise returns produce a `500` response.

Enable the optional scanner blocker before startup:

```javascript
import { createScannerBlocker } from 'roster-server/plugins/scanner-blocker.js';

roster.use(createScannerBlocker());
```

The blocker rejects common PHP, WordPress, repository, and sensitive-file probes with `404`. Defaults: a `60000` ms strike window, `3` strikes, a `900000` ms ban, `10000` tracked clients, and `trustProxy: false`. Configure `windowMs`, `strikeThreshold`, `banDurationMs`, and `maxTrackedClients` on the plugin. State is bounded, in memory, and per process, so each isolated site keeps its own bans.

Enable `trustProxy` only behind a trusted proxy that overwrites `X-Forwarded-For`. The optional synchronous `onBlock(event)` callback can integrate the application's logging or enforcement; it does not itself provide shared or persistent bans.

## Troubleshooting and runtime limits

| Symptom | Check |
| --- | --- |
| Startup rejects with a port error | Free the conflicting port or change the configured range/port, then create a new instance. Standalone HTTPS also needs port 80. |
| A site returns `404` | Check the domain, routing port, entry filename, module type, and factory export. Discovered sites stay on 443. |
| A site import fails with a relative path | Pass an absolute `wwwPath`; explicit paths are not rebased onto `basePath`. |
| Static deep links return `404` | There is no SPA fallback; use a site handler when that behavior is required. |
| Socket.IO falls through or double-responds | Attach it to the supplied virtual server, return the ordinary HTTP handler, and let Socket.IO own its endpoint. |
| Certificates are missing in a worker | Ensure the manager has issued them into the same store before worker startup. `init()` alone does not bind ACME HTTP. |
| Shutdown times out | Inspect the aggregated errors and site hooks, active requests, and pending certificate operations. |

Local integration checks cover Node HTTP/TLS and Socket.IO polling/WebSocket shutdown on Node and Bun. In **Bun 1.3.4**, the tested `node:https` serving helper did not invoke `SNICallback`, and changing certificate files did not replace the served default certificate. This also occurred with the previous synchronous resolver; do not assume Node's SNI reload behavior on that runtime.

## Agent skill and development

The [RosterServer skill](skills/roster-server/SKILL.md) guides application integration:

```sh
npx skills add https://github.com/clasen/RosterServer --skill roster-server
```

Contributors can run `pnpm test` for the Node test suite. Examples live in [demo](demo); they are separate from the published API reference above.

## License

The MIT License (MIT)

Copyright (c) Martin Clasen

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
