'use strict';

// Covers the branches Roster takes only on Bun. Run with `bun test` (see the test:bun script).
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const Roster = require('../index.js');
const shim = require('../vendor/greenlock-express/greenlock-shim.js');
const greenlock = require('../vendor/greenlock-express/greenlock-express.js');

const onBun = typeof process.versions.bun === 'string';
const bunOnly = !onBun && 'Bun-only branch';

function tempDir(t, prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function installCertificate(store, subject, serial) {
    const directory = path.join(store, 'live', subject);
    fs.mkdirSync(directory, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(directory, 'privkey.pem'), '-out', path.join(directory, 'cert.pem'),
        '-subj', `/CN=${subject}`, '-addext', `subjectAltName=DNS:${subject}`,
        '-days', '1', '-set_serial', String(serial)], { stdio: 'ignore' });
    fs.writeFileSync(path.join(directory, 'chain.pem'), '');
}

// Starts Roster in production mode with Greenlock stubbed out and every listener on an ephemeral loopback port.
async function startProduction(t, { certificates = [], issue = async () => null } = {}) {
    const root = tempDir(t, 'roster-bun-');
    const store = path.join(root, 'greenlock.d');
    for (const [subject, serial] of certificates) installCertificate(store, subject, serial);
    const roster = new Roster({ wwwPath: path.join(root, 'www'), greenlockStorePath: store, closeTimeoutMs: 2000 });
    t.mock.method(shim, 'create', () => ({ get: issue }));
    t.mock.method(greenlock, 'init', () => ({
        ready(callback) {
            setImmediate(() => callback({
                httpServer: () => http.createServer(),
                httpsServer: () => { throw new Error('Bun must not use the Greenlock HTTPS server'); }
            }));
            return this;
        }
    }));
    const listen = roster._listen.bind(roster);
    roster._listen = server => listen(server, 0, '127.0.0.1');
    t.after(() => roster.close().catch(() => {}));
    return roster;
}

function get(port, host) {
    return new Promise((resolve, reject) => {
        https.get({
            hostname: '127.0.0.1', port, servername: host, headers: { host },
            rejectUnauthorized: false, agent: false
        }, res => {
            const serial = res.socket.getPeerCertificate().serialNumber;
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body, serial }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function localGet(port) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: 'localhost', port, agent: false }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

it('detects the runtime it is loaded in', () => {
    assert.equal(Roster.isBunRuntime, onBun);
});

it('serves isolated sites from the main process on Bun', { timeout: 20000, skip: bunOnly }, async t => {
    const wwwPath = path.join(tempDir(t, 'roster-bun-www-'), 'www');
    fs.mkdirSync(path.join(wwwPath, 'isolated.example'), { recursive: true });
    fs.writeFileSync(path.join(wwwPath, 'isolated.example', 'index.cjs'),
        'module.exports = () => (req, res) => res.end(String(process.pid));');
    const roster = new Roster({ local: true, wwwPath, isolation: true, minLocalPort: 19480, maxLocalPort: 19489 });
    t.after(() => roster.close().catch(() => {}));
    await roster.start();
    assert.equal(roster._isolate, false);
    const { port } = new URL(roster.getUrl('isolated.example'));
    assert.equal((await localGet(port)).body, String(process.pid));
});

it('serves HTTPS on Bun from the stored certificate of the first site', { timeout: 20000, skip: bunOnly }, async t => {
    const issue = t.mock.fn(async () => null);
    const roster = await startProduction(t, { certificates: [['example.com', 7]], issue });
    roster.register('example.com', () => (req, res) => res.end('bun route'));
    await roster.start();
    const port = roster.portServers[443].address().port;
    assert.deepEqual(await get(port, 'example.com'), { status: 200, body: 'bun route', serial: '07' });
    assert.deepEqual(await get(port, 'www.example.com').then(r => r.status), 301);
    assert.equal(issue.mock.callCount(), 0);
    await roster.close();
    assert.equal(roster.portServers[443].listening, false);
});

it('issues the first site certificate through Greenlock before binding HTTPS on Bun', { timeout: 20000, skip: bunOnly }, async t => {
    let roster;
    const issue = t.mock.fn(async ({ servername }) => { installCertificate(roster.greenlockStorePath, servername, 8); });
    roster = await startProduction(t, { issue });
    roster.register('example.com', () => (req, res) => res.end('issued'));
    await roster.start();
    assert.deepEqual(issue.mock.calls[0].arguments, [{ servername: 'example.com' }]);
    const port = roster.portServers[443].address().port;
    assert.deepEqual(await get(port, 'example.com'), { status: 200, body: 'issued', serial: '08' });
});

it('refuses to bind HTTPS on Bun when no certificate can be loaded', { timeout: 20000, skip: bunOnly }, async t => {
    const roster = await startProduction(t);
    roster.register('example.com', () => (req, res) => res.end('never'));
    await assert.rejects(roster.start(), /Bun runtime could not load TLS certificate files for example\.com/);
});

it('routes every host on the default port with the first site certificate on Bun', { timeout: 20000, skip: bunOnly }, async t => {
    // Bun never calls SNICallback, so a second site is routed by Host but served the first site's certificate.
    const roster = await startProduction(t, { certificates: [['example.com', 9], ['example.org', 10]] });
    roster.register('example.com', () => (req, res) => res.end('com'));
    roster.register('example.org', () => (req, res) => res.end('org'));
    await roster.start();
    const port = roster.portServers[443].address().port;
    assert.deepEqual(await get(port, 'example.com'), { status: 200, body: 'com', serial: '09' });
    assert.deepEqual(await get(port, 'example.org'), { status: 200, body: 'org', serial: '09' });
});

it('serves HTTPS on a custom port on Bun from the certificate of the site on that port', { timeout: 20000, skip: bunOnly }, async t => {
    const roster = await startProduction(t, { certificates: [['example.com', 11], ['api.example.org', 12]] });
    roster.register('example.com', () => (req, res) => res.end('default port'));
    roster.register('api.example.org:8443', () => (req, res) => res.end('custom port'));
    await roster.start();
    assert.deepEqual(await get(roster.portServers[443].address().port, 'example.com'),
        { status: 200, body: 'default port', serial: '0B' });
    assert.deepEqual(await get(roster.portServers[8443].address().port, 'api.example.org'),
        { status: 200, body: 'custom port', serial: '0C' });
});
