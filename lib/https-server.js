'use strict';

// HTTPS servers that select certificates per host and adopt handed-off sockets on Node and Bun.
// Bun's https.Server never calls SNICallback and treats a socket passed to emit('connection') as plain
// text, but its tls.Server does both. On Bun, a tls.Server therefore terminates TLS in front of an
// http.Server, which is returned so request, upgrade and connection handling stay those of Node.
const http = require('http');
const https = require('https');
const tls = require('tls');

const isBunRuntime = typeof Bun !== 'undefined' || process.release?.name === 'bun';
const kTlsServer = Symbol('roster.tlsServer');

// Before 1.4.3, Bun's tls.Server ignores setSecureContext(), so reloaded certificates would never be served.
const MIN_BUN_VERSION = [1, 4, 3];

function assertSupportedBunVersion(version) {
    const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
    if (!parts) throw new Error(`Cannot determine the Bun version from "${version}"`);
    for (let i = 0; i < MIN_BUN_VERSION.length; i++) {
        const part = Number(parts[i + 1]);
        if (part > MIN_BUN_VERSION[i]) return;
        if (part < MIN_BUN_VERSION[i]) {
            throw new Error(`roster-server requires Bun ${MIN_BUN_VERSION.join('.')} or later; this is Bun ${version}`);
        }
    }
}

if (isBunRuntime) assertSupportedBunVersion(process.versions.bun);

function createHttpsServer(options = {}, handler) {
    if (!isBunRuntime) return https.createServer(options, handler);

    const server = http.createServer(handler);
    const tlsServer = tls.createServer({ ALPNProtocols: ['http/1.1'], ...options });
    server[kTlsServer] = tlsServer;

    trackConnections(server);
    tlsServer.on('secureConnection', socket => server.emit('connection', socket));
    tlsServer.on('tlsClientError', (error, socket) => {
        if (server.listenerCount('tlsClientError')) server.emit('tlsClientError', error, socket);
        else socket.destroy();
    });
    tlsServer.on('listening', () => server.emit('listening'));
    tlsServer.on('error', error => server.emit('error', error));
    tlsServer.on('close', () => server.emit('close'));

    server.listen = (...args) => {
        tlsServer.listen(...args);
        return server;
    };
    server.close = callback => {
        tlsServer.close(callback);
        server.closeIdleConnections();
        return server;
    };
    server.address = () => tlsServer.address();
    server.ref = () => { tlsServer.ref(); return server; };
    server.unref = () => { tlsServer.unref(); return server; };
    Object.defineProperty(server, 'listening', { get: () => tlsServer.listening });
    server.setSecureContext = options => tlsServer.setSecureContext(options);
    server.addContext = (hostname, context) => tlsServer.addContext(hostname, context);
    return server;
}

// Bun's http.Server neither applies keepAliveTimeout to connections passed to emit('connection') nor
// closes them in closeIdleConnections(), so the connection lifecycle is kept here.
function trackConnections(server) {
    const active = new Set();
    const idleTimers = new Map();
    const setIdle = socket => {
        active.delete(socket);
        clearTimeout(idleTimers.get(socket));
        const timeout = server.keepAliveTimeout;
        idleTimers.set(socket, timeout > 0 ? setTimeout(() => socket.destroy(), timeout).unref() : null);
    };
    const forget = socket => {
        active.delete(socket);
        clearTimeout(idleTimers.get(socket));
        idleTimers.delete(socket);
    };
    const onRequest = (req, res) => {
        const socket = req.socket;
        if (!idleTimers.has(socket)) return;
        clearTimeout(idleTimers.get(socket));
        idleTimers.set(socket, null);
        active.add(socket);
        res.once('finish', () => { if (idleTimers.has(socket) && !socket.destroyed) setIdle(socket); });
    };
    // Observed from emit() so the server's listeners stay exactly those its users added.
    const emit = server.emit;
    server.emit = function (event, ...args) {
        if (event === 'connection') {
            const socket = args[0];
            idleTimers.set(socket, null);
            socket.once('close', () => forget(socket));
        } else if (event === 'request') {
            onRequest(...args);
        } else if (event === 'upgrade') {
            // An upgraded socket belongs to its upgrade handler.
            forget(args[0].socket);
        }
        return emit.call(this, event, ...args);
    };
    server.closeIdleConnections = () => {
        for (const socket of idleTimers.keys()) if (!active.has(socket)) socket.destroy();
    };
    server.closeAllConnections = () => {
        for (const socket of idleTimers.keys()) socket.destroy();
    };
}

// Hands a raw client socket, with any bytes already read pushed back, to an HTTPS server to terminate TLS.
function acceptTlsConnection(server, socket) {
    (server[kTlsServer] || server).emit('connection', socket);
}

module.exports = { createHttpsServer, acceptTlsConnection, isBunRuntime, assertSupportedBunVersion };
