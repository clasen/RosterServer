# 👾 RosterServer

**Because hosting multiple HTTPS sites has never been easier!**

Welcome to **RosterServer**, the ultimate domain host router with automatic HTTPS and virtual hosting. Why juggle multiple servers when you can have one server to rule them all? 😉

## ✨ Features

- **Automatic HTTPS** with Let's Encrypt via Greenlock.
- **Dynamic Site Loading**: Just drop your Node.js apps in the `www` folder.
- **Virtual Hosting**: Serve multiple domains from a single server.
- **Automatic Redirects**: Redirect `www` subdomains to the root domain.
- **Zero Configuration**: Well, almost zero. Just a tiny bit of setup.

## 📦 Installation

```bash
npm install roster-server
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
    └── subdomain.example.com/
    │   └── index.js
    └── other-domain.com/
        └── index.js        
```

### Setting Up Your Server

```javascript
// /srv/roster/server.js
const Roster = require('roster-server');

const options = {
    email: 'admin@example.com',
    greenlockStorePath: '/srv/greenlock.d', // Path to your Greenlock configuration directory
    wwwPath: '/srv/www' // Path to your 'www' directory (default: '../www')
};

const server = new Roster(options);
server.start();
```

### Your Site Handlers

Each domain should have its own folder under `www`, containing an `index.js` that exports a request handler function.

### Examples

I'll help analyze the example files shown. You have 3 different implementations demonstrating various ways to handle requests in RosterServer:

1. **Basic HTTP Handler**:
```javascript:demo/www/example.com/index.js
module.exports = (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('"Loco de pensar, queriendo entrar en razón, y el corazón tiene razones que la propia razón nunca entenderá."');
    };
};
```

2. **Express App**:
```javascript:demo/www/express.example.com/index.js
const express = require('express');

module.exports = (httpsServer) => {
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
const { Server } = require('socket.io');

module.exports = (httpsServer) => {
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
# /srv/roster/server.js
node server.js
```

And that's it! Your server is now hosting multiple HTTPS-enabled sites. 🎉

## 🤯 But Wait, There's More!

### Automatic SSL Certificate Management

RosterServer uses [greenlock-express](https://www.npmjs.com/package/greenlock-express) to automatically obtain and renew SSL certificates from Let's Encrypt. No need to manually manage certificates ever again. Unless you enjoy that sort of thing. 🧐

### Redirects from `www`

All requests to `www.yourdomain.com` are automatically redirected to `yourdomain.com`. Because who needs the extra three characters? 😏

### Dynamic Site Loading

Add a new site? Just drop it into the `www` folder with an `index.js` file, and RosterServer will handle the rest. No need to restart the server. Well, you might need to restart the server. But that's what `nodemon` is for, right? 😅

## ⚙️ Configuration Options 

When creating a new `RosterServer` instance, you can pass the following options:

- `email` (string): Your email for Let's Encrypt notifications.
- `wwwPath` (string): Path to your `www` directory containing your sites.
- `greenlockStorePath` (string): Directory for Greenlock configuration.
- `staging` (boolean): Set to `true` to use Let's Encrypt's staging environment (for testing).
- `local` (boolean): Set to `true` to run in local development mode.
- `minLocalPort` (number): Minimum port for local mode (default: 4000).
- `maxLocalPort` (number): Maximum port for local mode (default: 9999).

## 🏠 Local Development Mode

For local development and testing, you can run RosterServer in local mode by setting `local: true`. This mode is perfect for development environments where you don't need SSL certificates or production features.

When `{ local: true }` is enabled, RosterServer **Skips SSL/HTTPS**: Runs pure HTTP servers instead of HTTPS.

### Setting Up Local Mode

```javascript
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