'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const Roster = require('../index.js');

async function createRoster(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-https-'));
    const roster = new Roster({
        local: false, autoCertificates: false,
        wwwPath: path.join(root, 'www'), greenlockStorePath: root
    });
    t.after(async () => {
        await roster.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    roster.register('example.com', () => (req, res) => res.end('apex'));
    roster.register('*.example.com', () => (req, res) => res.end('wildcard'));
    roster.register('api.example.com', () => (req, res) => res.end('exact'));
    await roster.init();
    return roster;
}

function certificate(roster, subject, serial) {
    const directory = path.join(roster.greenlockStorePath, 'live', subject);
    fs.mkdirSync(directory, { recursive: true });
    const key = path.join(directory, 'privkey.pem');
    const cert = path.join(directory, 'cert.pem');
    const keyArgs = fs.existsSync(key) ? ['-key', key] : ['-newkey', 'rsa:2048', '-nodes', '-keyout', key];
    execFileSync('openssl', ['req', '-x509', ...keyArgs, '-out', cert,
        '-subj', '/CN=example.com', '-days', '1', '-set_serial', String(serial)], { stdio: 'ignore' });
    fs.writeFileSync(path.join(directory, 'chain.pem'), '');
    return directory;
}

async function listen(t, server) {
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server;
}

function request(server, host, servername = host) {
    return new Promise((resolve, reject) => {
        https.get({
            hostname: '127.0.0.1', port: server.address().port, servername,
            headers: { host }, rejectUnauthorized: false, agent: false
        }, res => {
            const serial = res.socket.getPeerCertificate().serialNumber;
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body, serial }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

it('routes real HTTPS requests using SNI, wildcard storage, and exact host precedence', { timeout: 10000 }, async t => {
    const roster = await createRoster(t);
    certificate(roster, 'example.com', 1);
    certificate(roster, '_wildcard_.example.com', 2);
    certificate(roster, 'api.example.com', 3);
    const server = await listen(t, await roster.createServingHttpsServer({ servername: 'example.com' }));
    assert.deepEqual(await request(server, 'example.com'), { status: 200, body: 'apex', serial: '01' });
    assert.deepEqual(await request(server, 'shop.example.com'), { status: 200, body: 'wildcard', serial: '02' });
    assert.deepEqual(await request(server, 'api.example.com'), { status: 200, body: 'exact', serial: '03' });
    assert.equal((await request(server, 'unknown.test', 'example.com')).status, 404);
    assert.deepEqual(await request(server, 'example.com', ''), { status: 200, body: 'apex', serial: '01' });
    await roster.close();
    assert.equal(server.listening, true);
    assert.equal(server.listenerCount('request'), 0);
    assert.equal(server.listenerCount('upgrade'), 0);
});

it('reloads certificates on fresh TLS handshakes and recovers from invalid PEM files', { timeout: 10000 }, async t => {
    const roster = await createRoster(t);
    const directory = certificate(roster, 'example.com', 1);
    const server = await listen(t, await roster.createServingHttpsServer({ servername: 'example.com' }));
    assert.equal((await request(server, 'example.com')).serial, '01');
    fs.writeFileSync(path.join(directory, 'cert.pem'), 'invalid certificate');
    await assert.rejects(request(server, 'example.com'));
    certificate(roster, 'example.com', 2);
    assert.deepEqual(await request(server, 'example.com'), { status: 200, body: 'apex', serial: '02' });
    fs.unlinkSync(path.join(directory, 'cert.pem'));
    await assert.rejects(request(server, 'example.com'));
    certificate(roster, 'example.com', 3);
    assert.equal((await request(server, 'example.com')).serial, '03');
});

it('coalesces managed certificate issuance and serves the resulting certificate', { timeout: 10000 }, async t => {
    const roster = await createRoster(t);
    const issuance = t.mock.fn(async () => { certificate(roster, 'example.com', 4); });
    roster._greenlockRuntime = { get: issuance };
    const servers = await Promise.all(Array.from({ length: 3 }, () =>
        roster.createManagedHttpsServer({ servername: 'EXAMPLE.COM' })
    ));
    for (const server of servers) await listen(t, server);
    assert.equal(issuance.mock.callCount(), 1);
    assert.deepEqual(issuance.mock.calls[0].arguments, [{ servername: 'example.com' }]);
    for (const server of servers) {
        assert.deepEqual(await request(server, 'example.com'), { status: 200, body: 'apex', serial: '04' });
    }
    await roster.ensureCertificate('example.com');
    assert.equal(issuance.mock.callCount(), 1);
});

it('reports issuance failure or missing output and permits a subsequent successful check', { timeout: 10000 }, async t => {
    const roster = await createRoster(t);
    const failure = new Error('certificate authority unavailable');
    roster._greenlockRuntime = { get: t.mock.fn(async () => { throw failure; }) };
    await assert.rejects(roster.ensureCertificate('example.com'), error => error === failure);
    roster._greenlockRuntime.get = t.mock.fn(async () => {});
    await assert.rejects(roster.ensureCertificate('example.com'), /no PEM files/);
    roster._greenlockRuntime.get = t.mock.fn(async () => { certificate(roster, 'example.com', 5); });
    const pems = await roster.ensureCertificate('example.com');
    assert.ok(pems.cert.includes('BEGIN CERTIFICATE'));
    assert.equal(roster._greenlockRuntime.get.mock.callCount(), 1);
});

it('serving-only creation never issues a missing certificate', async t => {
    const roster = await createRoster(t);
    const issuance = t.mock.fn(async () => { throw new Error('Unexpected issuance'); });
    roster._greenlockRuntime = { get: issuance };
    await assert.rejects(roster.createServingHttpsServer({ servername: 'example.com' }), /No certificate files/);
    assert.equal(issuance.mock.callCount(), 0);
});

it('resolves a missing SNI certificate through the shared issuer', { timeout: 10000 }, async t => {
    const roster = await createRoster(t);
    certificate(roster, 'example.com', 1);
    const issuance = t.mock.fn(async ({ servername }) => { certificate(roster, servername, 6); });
    roster._greenlockRuntime = { get: issuance };
    const server = await listen(t, await roster.createServingHttpsServer({ servername: 'example.com' }));
    const result = await request(server, 'example.com', 'other.test');
    assert.deepEqual(result, { status: 200, body: 'apex', serial: '06' });
    assert.deepEqual(issuance.mock.calls[0].arguments, [{ servername: 'other.test' }]);
    await request(server, 'example.com', 'other.test');
    assert.equal(issuance.mock.callCount(), 1);
});
