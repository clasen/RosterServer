# 👾 RosterServer

**Because hosting multiple HTTPS sites has never been easier!**

Welcome to **RosterServer**, the ultimate domain host router with automatic HTTPS and virtual hosting. Why juggle multiple servers when you can have one server to rule them all? 😉

## ✨ Features

- **Automatic HTTPS** with Let's Encrypt via Greenlock.
- **Dynamic Site Loading**: Just drop your Node.js apps in the `www` folder.
- **Static Sites**: No code? No problem. Drop a folder with `index.html` (and assets) and RosterServer serves it automatically—modular static handler with path-traversal protection and strict 404s.
- **Virtual Hosting**: Serve multiple domains from a single server.
- **Automatic Redirects**: Redirect `www` subdomains to the root domain.
- **Zero Configuration**: Well, almost zero. Just a tiny bit of setup.
- **Bun compatible**: Works with both Node.js and [Bun](https://bun.sh).

## 📦 Installation

```bash
npm install roster-server
```

Or with [Bun](https://bun.sh):

```bash
bun add roster-server
```

## 🤖 AI Skill

You can also add RosterServer as a skill for AI agentic development:

```bash
npx skills add https://github.com/clasen/RosterServer --skill roster-server
```

## 🛠️ Usage

### Directory Structure

Your project should look something like this:

```
/srv/
├── greenlock.d/
├── roster/server.js
└── www/
    ├── example.com/
    │   └── index.js
    ├── subdomain.example.com/
    │   └── index.js
    ├── static-site.com/        # Static site: no index.js needed
    │   ├── index.html
    │   ├── css/
    │   └── images/
    ├── other-domain.com/
    │   └── index.js
    └── *.example.com/          # Wildcard: one handler for all subdomains (api.example.com, app.example.com, etc.)
        └── index.js
```

Each domain folder can have either:
- **Node app**: `index.js`, `index.mjs`, or `index.cjs` (exporting a request handler).
- **Static site**: `index.html` (and any assets). If no JS entry exists, RosterServer serves the folder as static files. Node takes precedence when both exist.

### Wildcard DNS (*.example.com)

You can serve all subdomains of a domain with a single handler in three ways:

1. **Folder**: Create a directory named literally `*.example.com` under `www` (e.g. `www/*.example.com/index.js`). Any request to `api.example.com`, `app.example.com`, etc. will use that handler.
2. **Register (default port)**: `roster.register('*.example.com', handler)` for the default HTTPS port.
3. **Register (custom port)**: `roster.register('*.example.com:8080', handler)` for a specific port.

Wildcard SSL certificates require **DNS-01** validation (Let's Encrypt does not support HTTP-01 for wildcards). By default Roster uses `acme-dns-01-cli` through an internal wrapper (adds `propagationDelay` and modern plugin signatures).

For fully automatic TXT records with Linode DNS, set:

```bash
export ROSTER_DNS_PROVIDER=linode
export LINODE_API_KEY=...
```

Then Roster creates/removes `_acme-challenge` TXT records automatically via `api.linode.com`.
If `LINODE_API_KEY` is present, this mode auto-enables by default for wildcard DNS-01.

Override with a custom plugin:

```javascript
import Roster from 'roster-server';

const roster = new Roster({
    email: 'admin@example.com',
    wwwPath: '/srv/www',
    greenlockStorePath: '/srv/greenlock.d',
    dnsChallenge: { module: 'acme-dns-01-route53', /* provider options */ }  // optional override
});
```

Set `dnsChallenge: false` to disable. For other DNS providers install the plugin in your app and pass it. See [Greenlock DNS plugins](https://git.rootprojects.org/root/greenlock-express.js#dns-01-challenge-plugins).

### Setting Up Your Server

```javascript
// /srv/roster/server.js
import Roster from 'roster-server';

const options = {
    email: 'admin@example.com',
    greenlockStorePath: '/srv/greenlock.d', // Path to your Greenlock configuration directory
    wwwPath: '/srv/www' // Path to your 'www' directory (default: '../www')
};

const server = new Roster(options);
server.start();
```

### Your Site Handlers

Each domain has its own folder under `www`. You can use:

- **Node app**: Put `index.js` (or `index.mjs` / `index.cjs`) that exports a request handler function.
- **Static site**: Put `index.html` and your assets (CSS, JS, images). RosterServer will serve files from that folder. `GET /` serves `index.html`; other paths serve the file if it exists, or 404. Path traversal is blocked. If both an index script and `index.html` exist, the script is used.

### Examples

I'll help analyze the example files shown. You have 3 different implementations demonstrating various ways to handle requests in RosterServer:

1. **Basic HTTP Handler**:
```javascript:demo/www/example.com/index.js
export default (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('"Loco de pensar, queriendo entrar en razón, y el corazón tiene razones que la propia razón nunca entenderá."');
    };
};
```

2. **Express App**:
```javascript:demo/www/express.example.com/index.js
import express from 'express';

export default (httpsServer) => {
    const app = express();
    app.get('/', (req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send('"Loco de pensar, queriendo entrar en razón, y el corazón tiene razones que la propia razón nunca entenderá."');
    });

    return app;
}
```

3. **Socket.IO Server**:
```javascript:demo/www/sio.example.com/index.js
import { Server } from 'socket.io';

export default (httpsServer) => {
    const io = new Server(httpsServer);

    io.on('connection', (socket) => {
        console.log('A user connected');

        socket.on('chat:message', (msg) => {
            console.log('Message received:', msg);
            io.emit('chat:message', msg);
        });

        socket.on('disconnect', () => {
            console.log('User disconnected');
        });
    });

    return (req, res) => {
        if (req.url && req.url.startsWith(io.opts.path)) return;
        res.writeHead(200);
        res.end('Socket.IO server running');
    };
};
```

4. **Manual**:
```javascript:demo/www/manual.js
roster.register('example.com', (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('"Loco de pensar, queriendo entrar en razón, y el corazón tiene razones que la propia razón nunca entenderá."');
    };
});
```

5. **Manual: Custom port**:
```javascript:demo/www/manual.js
roster.register('example.com:8080', (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('"Mad with thought, striving to embrace reason, yet the heart holds reasons that reason itself shall never comprehend."');
    };
});
```

### Running the Server

```bash
# With Node.js
node server.js
```

Or with Bun:

```bash
bun server.js
```

And that's it! Your server is now hosting multiple HTTPS-enabled sites. 🎉

## 🤯 But Wait, There's More!

### Static Sites (index.html)

Domains under `www` that have no `index.js`/`index.mjs`/`index.cjs` but do have `index.html` are served as static sites. The logic lives in `lib/static-site-handler.js` and `lib/resolve-site-app.js`:

- **`GET /`** and **`GET /index.html`** serve `index.html`.
- Any other path serves the file under the domain folder if it exists; otherwise **404** (strict, no SPA fallback).
- Path traversal (e.g. `/../`) is rejected with **403**.
- Content-Type is set from extension (html, css, js, images, fonts, etc.).

No Express or extra dependencies—plain Node. At startup you’ll see `(✔) Loaded site: https://example.com (static)` for these domains.

### Automatic SSL Certificate Management

RosterServer uses [greenlock-express](https://www.npmjs.com/package/greenlock-express) to automatically obtain and renew SSL certificates from Let's Encrypt. No need to manually manage certificates ever again. Unless you enjoy that sort of thing. 🧐

### Redirects from `www`

All requests to `www.yourdomain.com` are automatically redirected to `yourdomain.com`. Because who needs the extra three characters? 😏

### Dynamic Site Loading

Add a new site? Drop it into the `www` folder: either an `index.js` (or `.mjs`/`.cjs`) for a Node app, or an `index.html` (plus assets) for a static site. RosterServer picks the right handler automatically. Restart the server to load new sites—nodemon has your back. 😅

## ⚙️ Configuration Options 

When creating a new `RosterServer` instance, you can pass the following options:

- `email` (string): Your email for Let's Encrypt notifications.
- `wwwPath` (string): Path to your `www` directory containing your sites.
- `greenlockStorePath` (string): Directory for Greenlock configuration.
- `dnsChallenge` (object|false): Optional override for wildcard DNS-01 challenge config. Default is `acme-dns-01-cli` wrapper with `propagationDelay: 120000`, `autoContinue: false`, and `dryRunDelay: 120000`. Manual mode still works, but you can enable automatic Linode DNS API mode by setting `ROSTER_DNS_PROVIDER=linode` and `LINODE_API_KEY`. In automatic mode, Roster creates/removes TXT records itself and still polls public resolvers every 15s before continuing. Set `false` to disable DNS challenge. You can pass `{ module: '...', propagationDelay: 180000 }` to tune DNS wait time (ms). For Greenlock dry-runs (`_greenlock-dryrun-*`), delay defaults to `dryRunDelay` (same as `propagationDelay` unless overridden with `dnsChallenge.dryRunDelay` or env `ROSTER_DNS_DRYRUN_DELAY_MS`). When wildcard sites are present, Roster creates a separate wildcard certificate (`*.example.com`) that uses `dns-01`, while apex/www stay on the regular certificate flow (typically `http-01`), reducing manual TXT records.
- `staging` (boolean): Set to `true` to use Let's Encrypt's staging environment (for testing).
- `local` (boolean): Set to `true` to run in local development mode.
- `minLocalPort` (number): Minimum port for local mode (default: 4000).
- `maxLocalPort` (number): Maximum port for local mode (default: 9999).

## 🏠 Local Development Mode

For local development and testing, you can run RosterServer in local mode by setting `local: true`. This mode is perfect for development environments where you don't need SSL certificates or production features.

When `{ local: true }` is enabled, RosterServer **Skips SSL/HTTPS**: Runs pure HTTP servers instead of HTTPS.

### Setting Up Local Mode

```javascript
import Roster from 'roster-server';

const server = new Roster({
    wwwPath: '/srv/www',
    local: true,  // Enable local development mode
    minLocalPort: 4000,  // Optional: minimum port (default: 4000)
    maxLocalPort: 9999   // Optional: maximum port (default: 9999)
});
server.start();
```

### Port Assignment

In local mode, domains are automatically assigned ports based on a CRC32 hash of the domain name (default range 4000-9999, configurable via `minLocalPort` and `maxLocalPort`):

- `example.com` → `http://localhost:9465`
- `api.example.com` → `http://localhost:9388`  
- And so on...

You can customize the port range:

```javascript
import Roster from 'roster-server';

const roster = new Roster({ 
    local: true,
    minLocalPort: 5000,  // Start from port 5000
    maxLocalPort: 6000   // Up to port 6000
});
```

### Getting URLs

RosterServer provides a method to get the URL for a domain that adapts automatically to your environment:

**Instance Method: `roster.getUrl(domain)`**

```javascript
import Roster from 'roster-server';

const roster = new Roster({ local: true });
roster.register('example.com', handler);

await roster.start();

// Get the URL - automatically adapts to environment
const url = roster.getUrl('example.com');
console.log(url); 
// Local mode: http://localhost:9465
// Production mode: https://example.com
```

This method:
- Returns the correct URL based on your environment (`local: true/false`)
- In **local mode**: Returns `http://localhost:{port}` with the assigned port
- In **production mode**: Returns `https://{domain}` (or with custom port if configured)
- Handles `www.` prefix automatically (returns same URL)
- Returns `null` for domains that aren't registered

**Example Usage:**

```javascript
import Roster from 'roster-server';

// Local development
const localRoster = new Roster({ local: true });
localRoster.register('example.com', handler);
await localRoster.start();
console.log(localRoster.getUrl('example.com')); 
// → http://localhost:9465

// Production
const prodRoster = new Roster({ local: false });
prodRoster.register('example.com', handler);
await prodRoster.start();
console.log(prodRoster.getUrl('example.com')); 
// → https://example.com

// Production with custom port
const customRoster = new Roster({ local: false, port: 8443 });
customRoster.register('api.example.com', handler);
await customRoster.start();
console.log(customRoster.getUrl('api.example.com')); 
// → https://api.example.com:8443
```

## 🧂 A Touch of Magic

You might be thinking, "But setting up HTTPS and virtual hosts is supposed to be complicated and time-consuming!" Well, not anymore. With RosterServer, you can get back to writing code that matters, like defending Earth from alien invaders! 👾👾👾


## 🤝 Contributing

Feel free to submit issues or pull requests. Or don't. I'm not your boss. 😜

If you find any issues or have suggestions for improvement, please open an issue or submit a pull request on the [GitHub repository](https://github.com/clasen/RosterServer).

## 🙏 Acknowledgments 

- [Node.js](https://nodejs.org/) - JavaScript runtime
- [Greenlock](https://git.coolaj86.com/coolaj86/greenlock.js) - Fully-featured ACME client

## 📄 License

The MIT License (MIT)

Copyright (c) Martin Clasen

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

Happy hosting! 🎈