'use strict';

// Entry point of an isolated site process, forked by IsolatedSite.
const https = require('https');
const net = require('net');
const Roster = require('../index.js');
const { resolveSiteApp, isSocketSite } = require('./resolve-site-app.js');
const { serializeError } = require('./isolated-site.js');
const log = require('lemonlog')('roster');

class SiteWorkerRoster extends Roster {
    constructor(site) {
        super({ ...site.options, isolation: false, autoCertificates: false, handleSignals: false });
        this._site = site;
        this._socketSite = null;
        this._socketSiteClose = null;
        this._httpsServers = new Map();
        this._certificateRequests = new Map();
        this._nextCertificateRequest = 0;
        // Certificates are issued by the main process, which owns the ACME runtime.
        this._greenlockRuntime = { get: ({ servername }) => this._requestCertificate(servername) };
    }

    async loadSites() {
        const { path: sitePath, keys } = this._site;
        let resolved;
        try {
            resolved = await resolveSiteApp(sitePath, { filename: this.filename });
        } catch (error) {
            log.warn(`⚠️  Error loading site in ${sitePath}:`, error);
            return;
        }
        if (!resolved) {
            log.warn(`⚠️  No index file (js/mjs/cjs or index.html) found in ${sitePath}`);
            return;
        }
        if (isSocketSite(resolved.siteApp)) {
            this._socketSite = resolved.siteApp;
            return;
        }
        for (const key of keys) this.sites[key] = resolved.siteApp;
    }

    get socketSite() {
        return this._socketSite !== null;
    }

    // The site terminates TLS with certificates Roster resolves: read from the store, or issued by the main process.
    startSocketSite() {
        return this._socketSite.start?.({ certificate: servername => this.ensureCertificate(servername) });
    }

    // In local mode a socket site gets plain connections on its assigned ports, with no ClientHello.
    async serveLocalSockets() {
        const head = Buffer.alloc(0);
        for (const key of this._site.keys) {
            if (key.startsWith('www.')) continue;
            const { domain, port } = this.parseDomainWithPort(key);
            const localPort = this._site.localPorts[`${domain}:${port}`];
            const server = net.createServer({ pauseOnConnect: true });
            const listening = this._listen(server, localPort, this.hostname);
            server.on('connection', socket => {
                // The site owns the connection from here; it may pass it to another process.
                this._sockets.delete(socket);
                this._handOff(head, socket);
            });
            await listening;
            log.info(`🌐 ${this._describeLocalSite(domain, port, localPort, 'tcp')} (socket site)`);
        }
    }

    _handOff(head, socket) {
        if (this._closing || socket.destroyed) {
            socket.destroy();
            return;
        }
        try {
            this._socketSite.connection(socket, head);
        } catch (error) {
            socket.destroy();
            log.error(`❌ Socket site ${this._site.name} rejected a connection:`, error);
        }
    }

    close() {
        if (!this._socketSite) return super.close();
        // Stop accepting first, then let the site drain the connections it was handed.
        this._socketSiteClose ??= Promise.allSettled([super.close()]).then(async ([listeners]) => {
            const errors = listeners.status === 'rejected' ? [listeners.reason] : [];
            try {
                await this._socketSite.close?.();
            } catch (error) {
                errors.push(error);
            }
            const flat = errors.flatMap(error => error instanceof AggregateError ? error.errors : [error]);
            if (flat.length) throw new AggregateError(flat, 'Roster close failed');
        });
        return this._socketSiteClose;
    }

    generateConfigJson() {}

    assignPortToDomain(domain, port) {
        return this._site.localPorts[`${domain}:${port}`];
    }

    _requestCertificate(servername) {
        const id = this._nextCertificateRequest++;
        return new Promise((resolve, reject) => {
            this._certificateRequests.set(id, { resolve, reject });
            process.send({ type: 'certificate', id, servername });
        });
    }

    rejectCertificateRequests() {
        for (const request of this._certificateRequests.values()) {
            request.reject(new Error('Main process disconnected'));
        }
        this._certificateRequests.clear();
    }

    settleCertificate({ id, error }) {
        const request = this._certificateRequests.get(id);
        this._certificateRequests.delete(id);
        if (error) request.reject(new Error(error.message));
        else request.resolve();
    }

    serveHttps() {
        const ports = new Set(this._site.keys.map(key => this.parseDomainWithPort(key).port));
        for (const port of ports) {
            // Only the default port issues missing certificates, as in the main process.
            const issue = port === this.defaultPort;
            const server = this._configureSiteServer(https.createServer({
                minVersion: this.tlsMinVersion,
                maxVersion: this.tlsMaxVersion,
                SNICallback: (servername, callback) => {
                    this._getSecureContext(servername, issue).then(context => callback(null, context), callback);
                }
            }));
            this.attach(server, { port });
            this._ownedServers.add(server);
            this._httpsServers.set(port, server);
        }
    }

    accept(port, head, socket) {
        if (this._socketSite) {
            this._handOff(head, socket);
            return;
        }
        const server = this._httpsServers.get(port);
        if (this._closing || !server) {
            socket.destroy();
            return;
        }
        this._sockets.add(socket);
        socket.once('close', () => this._sockets.delete(socket));
        socket.unshift(head);
        server.emit('connection', socket);
    }
}

let roster = null;
let closing = false;

async function start(site) {
    process.title = `roster ${site.name}`;
    roster = new SiteWorkerRoster(site);
    try {
        for (const plugin of site.plugins) {
            roster.use(require(plugin.module)[plugin.export](plugin.options));
        }
        await roster.init();
        if (roster.socketSite) {
            await roster.startSocketSite();
            if (roster.local) await roster.serveLocalSockets();
        } else if (roster.local) {
            await roster.start();
        } else {
            roster.serveHttps();
        }
        process.send({ type: 'ready' });
    } catch (error) {
        if (closing) return;
        process.send({ type: 'failed', error: serializeError(error) }, () => process.exit(1));
    }
}

async function shutdown() {
    if (closing) return;
    closing = true;
    let errors = [];
    if (roster && !process.connected) roster.rejectCertificateRequests();
    try {
        if (roster) await roster.close();
    } catch (error) {
        errors = error instanceof AggregateError ? error.errors : [error];
    }
    if (!process.connected) process.exit(0);
    process.send({ type: 'closed', errors: errors.map(serializeError) }, () => process.exit(0));
}

// The main process coordinates shutdown; a terminal or process manager that
// signals the whole process group must not cut this site's drain short.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
process.on('disconnect', shutdown);
process.on('message', (message, handle) => {
    if (message.type === 'start') start(message);
    else if (message.type === 'connection') {
        // A connection can close while its socket is being transferred over IPC.
        if (!handle) return;
        if (roster) roster.accept(message.port, Buffer.from(message.head, 'base64'), handle);
        else handle.destroy();
    } else if (message.type === 'certificate') roster.settleCertificate(message);
    else if (message.type === 'close') shutdown();
});
