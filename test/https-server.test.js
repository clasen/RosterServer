'use strict';

// The HTTPS server factory must behave the same on Node and Bun: run with `pnpm test` and `pnpm test:bun`.
const { it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const Roster = require('../index.js');
const { createHttpsServer, acceptTlsConnection } = Roster;
const { parseClientHello } = require('../lib/client-hello.js');
const { assertSupportedBunVersion } = require('../lib/https-server.js');

const pems = {};
before(() => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-https-server-'));
    for (const [name, serial] of [['one.test', 1], ['two.test', 2]]) {
        const key = path.join(directory, `${name}.key`);
        const cert = path.join(directory, `${name}.crt`);
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
            '-subj', `/CN=${name}`, '-days', '1', '-set_serial', String(serial)], { stdio: 'ignore' });
        pems[name] = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    }
    fs.rmSync(directory, { recursive: true, force: true });
});

const sni = (servername, callback) => callback(null, tls.createSecureContext(pems[servername] || pems['one.test']));

async function listen(t, server) {
    t.after(() => new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
    }));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

function get(port, servername, agent = false) {
    return new Promise((resolve, reject) => {
        https.get({ hostname: '127.0.0.1', port, servername, rejectUnauthorized: false, agent }, res => {
            const serial = res.socket.getPeerCertificate().serialNumber;
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ serial, body }));
        }).on('error', reject);
    });
}

it('reports the runtime it is loaded in', () => {
    assert.equal(Roster.isBunRuntime, typeof process.versions.bun === 'string');
});

it('rejects Bun versions whose TLS server cannot replace certificates', () => {
    for (const version of ['1.4.3', '1.4.10', '1.5.0', '2.0.0', '1.4.4-canary.20261111.1']) {
        assert.doesNotThrow(() => assertSupportedBunVersion(version), version);
    }
    for (const version of ['1.4.2', '1.3.12', '0.9.9']) {
        assert.throws(() => assertSupportedBunVersion(version), /requires Bun 1\.4\.3 or later/, version);
    }
    assert.throws(() => assertSupportedBunVersion(undefined), /Cannot determine the Bun version/);
});

it('selects the certificate of each host through SNICallback', async t => {
    const server = createHttpsServer({ ...pems['one.test'], SNICallback: sni },
        (req, res) => res.end(`${req.socket.encrypted} ${req.socket.servername}`));
    const port = await listen(t, server);
    assert.equal(server.listening, true);
    assert.deepEqual(await get(port, 'one.test'), { serial: '01', body: 'true one.test' });
    assert.deepEqual(await get(port, 'two.test'), { serial: '02', body: 'true two.test' });
});

it('replaces the default certificate with setSecureContext', async t => {
    const server = createHttpsServer(pems['one.test'], (req, res) => res.end('ok'));
    const port = await listen(t, server);
    assert.equal((await get(port, '')).serial, '01');
    server.setSecureContext(pems['two.test']);
    assert.equal((await get(port, '')).serial, '02');
});

it('terminates TLS on a raw socket handed over after its ClientHello was read', async t => {
    const server = createHttpsServer({ SNICallback: sni }, (req, res) => res.end('adopted'));
    const front = net.createServer(socket => {
        let head = Buffer.alloc(0);
        const read = chunk => {
            head = Buffer.concat([head, chunk]);
            if (parseClientHello(head) === undefined) return;
            socket.removeListener('data', read);
            socket.pause();
            socket.unshift(head);
            acceptTlsConnection(server, socket);
        };
        socket.on('data', read);
    });
    const port = await listen(t, front);
    assert.deepEqual(await get(port, 'two.test'), { serial: '02', body: 'adopted' });
});

it('keeps connections alive between requests and closes them once idle', async t => {
    const server = createHttpsServer({ SNICallback: sni }, (req, res) => res.end(req.url));
    server.keepAliveTimeout = 300;
    let connections = 0;
    server.on('connection', () => connections++);
    const port = await listen(t, server);
    const { bodies, idleMs } = await new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port, servername: 'one.test', rejectUnauthorized: false });
        const send = pathname => socket.write(`GET ${pathname} HTTP/1.1\r\nHost: one.test\r\nConnection: keep-alive\r\n\r\n`);
        const bodies = [];
        let buffer = '';
        let answeredAt = null;
        socket.once('secureConnect', () => send('/first'));
        socket.on('data', data => {
            buffer += data;
            const responses = buffer.split('HTTP/1.1 ').slice(1).map(response => response.split('\r\n\r\n')[1]).filter(Boolean);
            if (responses.length === 1 && bodies.length === 0) {
                bodies.push(responses[0]);
                send('/second');
            } else if (responses.length === 2 && bodies.length === 1) {
                bodies.push(responses[1]);
                answeredAt = Date.now();
            }
        });
        socket.on('close', () => resolve({ bodies, idleMs: Date.now() - answeredAt }));
        socket.on('error', reject);
    });
    assert.deepEqual(bodies, ['/first', '/second']);
    assert.equal(connections, 1);
    assert.ok(idleMs >= 250 && idleMs < 2500, `connection stayed open ${idleMs} ms`);
});

it('closes idle connections but lets an active request finish', async t => {
    let release;
    const server = createHttpsServer({ SNICallback: sni }, (req, res) => {
        if (req.url === '/slow') release = () => res.end('slow');
        else res.end('fast');
    });
    const port = await listen(t, server);
    const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
    t.after(() => agent.destroy());
    await get(port, 'one.test', agent);
    const idleSocket = Object.values(agent.freeSockets).flat()[0];
    const idleClosed = new Promise(resolve => idleSocket.once('close', resolve));
    const slow = new Promise((resolve, reject) => {
        https.get({ hostname: '127.0.0.1', port, path: '/slow', servername: 'one.test', rejectUnauthorized: false, agent: false },
            res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(body)); })
            .on('error', reject);
    });
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    server.closeIdleConnections();
    await idleClosed;
    release();
    assert.equal(await slow, 'slow');
});

it('delivers upgrade requests with their socket', async t => {
    const server = createHttpsServer({ SNICallback: sni }, (req, res) => res.end('not upgraded'));
    server.on('upgrade', (req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
        socket.on('data', data => socket.write(`echo:${data}`));
    });
    server.keepAliveTimeout = 50;
    const port = await listen(t, server);
    const echoed = await new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port, servername: 'one.test', rejectUnauthorized: false }, () => {
            socket.write('GET / HTTP/1.1\r\nHost: one.test\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n');
        });
        let buffer = '';
        socket.on('data', data => {
            buffer += data;
            if (buffer.includes('\r\n\r\n') && !buffer.includes('echo:')) setTimeout(() => socket.write('ping'), 200);
            if (buffer.includes('echo:ping')) {
                socket.destroy();
                resolve(buffer.split('\r\n\r\n')[1]);
            }
        });
        socket.on('error', reject);
    });
    assert.equal(echoed, 'echo:ping');
});

it('reports listening, address and close like a Node server', async t => {
    const server = createHttpsServer({ SNICallback: sni }, (req, res) => res.end('ok'));
    const events = [];
    server.on('listening', () => events.push('listening'));
    server.on('close', () => events.push('close'));
    assert.equal(server.listening, false);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    assert.equal(server.address().address, '127.0.0.1');
    await new Promise(resolve => server.close(resolve));
    assert.equal(server.listening, false);
    assert.deepEqual(events, ['listening', 'close']);
    const error = await new Promise(resolve => server.close(resolve));
    assert.equal(error?.code, 'ERR_SERVER_NOT_RUNNING');
});
