'use strict';

const { it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { execFileSync, spawn } = require('node:child_process');
const Roster = require('../index.js');
const { parseClientHello } = require('../lib/client-hello.js');
const { createScannerBlocker } = require('../plugins/scanner-blocker.js');
const shim = require('../vendor/greenlock-express/greenlock-shim.js');
const greenlock = require('../vendor/greenlock-express/greenlock-express.js');

const REPORT_SITE = `module.exports = () => (req, res) => res.end(JSON.stringify({
    pid: process.pid, address: req.socket.remoteAddress, header: req.headers['x-test'] || null, host: req.headers.host
}));`;

let pki;
before(() => {
    pki = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-isolation-pki-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(pki, 'key.pem'), '-out', path.join(pki, 'cert.pem'),
        '-subj', '/CN=roster.test', '-days', '1'], { stdio: 'ignore' });
});
after(() => fs.rmSync(pki, { recursive: true, force: true }));

function installCertificate(store, subject) {
    const directory = path.join(store, 'live', subject);
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(path.join(pki, 'key.pem'), path.join(directory, 'privkey.pem'));
    fs.copyFileSync(path.join(pki, 'cert.pem'), path.join(directory, 'cert.pem'));
    fs.writeFileSync(path.join(directory, 'chain.pem'), '');
}

function createSite(wwwPath, domain, source) {
    fs.mkdirSync(path.join(wwwPath, domain), { recursive: true });
    fs.writeFileSync(path.join(wwwPath, domain, 'index.cjs'), source);
}

function createWww(t, sites) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-isolation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const wwwPath = path.join(root, 'www');
    fs.mkdirSync(wwwPath);
    for (const [domain, source] of Object.entries(sites)) createSite(wwwPath, domain, source);
    return { root, wwwPath };
}

async function startProduction(t, sites, { certificates = [], issue = async () => {}, configure = () => {} } = {}) {
    const { root, wwwPath } = createWww(t, sites);
    const store = path.join(root, 'greenlock.d');
    for (const subject of certificates) installCertificate(store, subject);
    const roster = new Roster({ wwwPath, greenlockStorePath: store, isolation: { restartDelayMs: 50 }, closeTimeoutMs: 5000 });
    t.mock.method(shim, 'create', () => ({ get: issue }));
    t.mock.method(greenlock, 'init', () => ({
        ready(callback) {
            setImmediate(() => callback({
                httpServer: () => http.createServer(),
                httpsServer: (options, handler) => https.createServer({ ...options, SNICallback: roster.sniCallback() }, handler)
            }));
            return this;
        }
    }));
    const listen = roster._listen.bind(roster);
    roster._listen = server => listen(server, 0, '127.0.0.1');
    configure(roster);
    t.after(() => roster.close().catch(() => {}));
    await roster.start();
    return { roster, port: roster.portServers[443].address().port, store };
}

function get(port, servername, { pathname = '/', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        https.get({
            hostname: '127.0.0.1', port, servername, path: pathname, agent: false,
            rejectUnauthorized: false, headers: { host: servername, ...headers }
        }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function localGet(port, pathname = '/') {
    return new Promise((resolve, reject) => {
        http.get({ hostname: 'localhost', port, path: pathname, agent: false }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

function isRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

it('routes each SNI host to its own process with the client address and headers intact', { timeout: 20000 }, async t => {
    const { port } = await startProduction(t, {
        'a.example.com': REPORT_SITE,
        'b.example.com': REPORT_SITE,
        '*.wild.example.com': REPORT_SITE
    }, {
        certificates: ['a.example.com', 'b.example.com', 'www.a.example.com', 'shop.wild.example.com', 'main.example.com'],
        configure: roster => roster.register('main.example.com', () => (req, res) => res.end(JSON.stringify({ pid: process.pid })))
    });
    const a = JSON.parse((await get(port, 'a.example.com', { headers: { 'x-test': 'kept' } })).body);
    const b = JSON.parse((await get(port, 'b.example.com')).body);
    const wildcard = JSON.parse((await get(port, 'shop.wild.example.com')).body);
    const main = JSON.parse((await get(port, 'main.example.com')).body);
    assert.equal(new Set([a.pid, b.pid, wildcard.pid, process.pid]).size, 4);
    assert.equal(main.pid, process.pid);
    assert.match(a.address, /127\.0\.0\.1$/);
    assert.equal(a.header, 'kept');
    assert.equal(wildcard.host, 'shop.wild.example.com');
    const redirect = await get(port, 'www.a.example.com', { pathname: '/path' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, 'https://a.example.com/path');
});

it('keeps serving other sites while one blocks its event loop', { timeout: 20000 }, async t => {
    const { port } = await startProduction(t, {
        'busy.example.com': `module.exports = () => (req, res) => {
            const end = Date.now() + 1500;
            while (Date.now() < end) {}
            res.end('done');
        };`,
        'calm.example.com': REPORT_SITE
    }, { certificates: ['busy.example.com', 'calm.example.com'] });
    const blocked = get(port, 'busy.example.com');
    await new Promise(resolve => setTimeout(resolve, 200));
    const startedAt = Date.now();
    assert.equal((await get(port, 'calm.example.com')).status, 200);
    assert.ok(Date.now() - startedAt < 1000, 'calm site waited for the busy site');
    assert.equal((await blocked).body, 'done');
});

it('restarts a crashed site while the others keep serving', { timeout: 20000 }, async t => {
    const { port } = await startProduction(t, {
        'fragile.example.com': `module.exports = () => (req, res) => {
            if (req.url === '/crash') setImmediate(() => { throw new Error('site crashed'); });
            else res.end(String(process.pid));
        };`,
        'steady.example.com': REPORT_SITE
    }, { certificates: ['fragile.example.com', 'steady.example.com'] });
    const firstPid = Number((await get(port, 'fragile.example.com')).body);
    await assert.rejects(get(port, 'fragile.example.com', { pathname: '/crash' }));
    assert.equal((await get(port, 'steady.example.com')).status, 200);
    let restartedPid;
    for (let attempt = 0; attempt < 50 && !restartedPid; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        restartedPid = await get(port, 'fragile.example.com').then(res => Number(res.body), () => null);
    }
    assert.ok(restartedPid, 'crashed site was not restarted');
    assert.notEqual(restartedPid, firstPid);
});

it('delivers WebSocket upgrades to the isolated site', { timeout: 20000 }, async t => {
    const { port } = await startProduction(t, {
        'ws.example.com': `module.exports = server => {
            server.on('upgrade', (req, socket) => {
                socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n');
                socket.on('data', data => socket.write(process.pid + ':' + data));
            });
            return (req, res) => res.end('http');
        };`
    }, { certificates: ['ws.example.com'] });
    const socket = tls.connect({ host: '127.0.0.1', port, servername: 'ws.example.com', rejectUnauthorized: false });
    t.after(() => socket.destroy());
    await once(socket, 'secureConnect');
    socket.write('GET / HTTP/1.1\r\nHost: ws.example.com\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
    const [handshake] = await once(socket, 'data');
    assert.match(String(handshake), /^HTTP\/1\.1 101/);
    socket.write('ping');
    const [echo] = await once(socket, 'data');
    const [pid, payload] = String(echo).split(':');
    assert.notEqual(Number(pid), process.pid);
    assert.equal(payload, 'ping');
});

it('closes isolated sites after their hooks run, reports hook errors, and stops their processes', { timeout: 20000 }, async t => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roster-isolation-marker-')), 'closed');
    t.after(() => fs.rmSync(path.dirname(marker), { recursive: true, force: true }));
    const { roster, port } = await startProduction(t, {
        'clean.example.com': `module.exports = server => {
            server.onClose(async () => require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)));
            return (req, res) => res.end(String(process.pid));
        };`,
        'failing.example.com': `module.exports = server => {
            server.onClose(() => { throw new Error('cleanup failed'); });
            return (req, res) => res.end(String(process.pid));
        };`
    }, { certificates: ['clean.example.com', 'failing.example.com'] });
    const pids = [
        Number((await get(port, 'clean.example.com')).body),
        Number((await get(port, 'failing.example.com')).body)
    ];
    await assert.rejects(roster.close(), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors.map(item => item.message), ['cleanup failed']);
        return true;
    });
    assert.equal(fs.readFileSync(marker, 'utf8'), String(pids[0]));
    assert.deepEqual(pids.map(isRunning), [false, false]);
});

it('rejects startup when an isolated site factory throws', { timeout: 20000 }, async t => {
    await assert.rejects(startProduction(t, {
        'broken.example.com': `module.exports = () => { throw new Error('factory failed'); };`,
        'fine.example.com': REPORT_SITE
    }), /factory failed/);
});

it('issues missing certificates for isolated sites through the main process', { timeout: 20000 }, async t => {
    let store;
    const issued = [];
    const { port } = await startProduction(t, { 'fresh.example.com': REPORT_SITE }, {
        issue: async ({ servername }) => {
            issued.push(servername);
            installCertificate(store, servername);
        },
        configure: roster => { store = roster.greenlockStorePath; }
    });
    assert.equal((await get(port, 'fresh.example.com')).status, 200);
    assert.deepEqual(issued, ['fresh.example.com']);
});

it('isolates directory sites in local mode, including aliases and request plugins', { timeout: 20000 }, async t => {
    const { wwwPath } = createWww(t, { 'site.example': REPORT_SITE, 'other.example': REPORT_SITE });
    const roster = new Roster({ local: true, wwwPath, minLocalPort: 19300, maxLocalPort: 19349 });
    t.after(() => roster.close().catch(() => {}));
    roster.use(createScannerBlocker());
    roster.register('alias.example', path.join(wwwPath, 'site.example'));
    await roster.start();
    const port = domain => new URL(roster.getUrl(domain)).port;
    const site = JSON.parse((await localGet(port('site.example'))).body);
    const alias = JSON.parse((await localGet(port('alias.example'))).body);
    const other = JSON.parse((await localGet(port('other.example'))).body);
    assert.notEqual(site.pid, process.pid);
    assert.equal(alias.pid, site.pid);
    assert.notEqual(other.pid, site.pid);
    assert.deepEqual(await localGet(port('other.example'), '/wp-login.php'), { status: 404, body: 'Not Found' });
});

it('serves a site module already loaded by the main process from that process', { timeout: 20000 }, async t => {
    const { wwwPath } = createWww(t, { 'loaded.example': REPORT_SITE });
    require(path.join(wwwPath, 'loaded.example', 'index.cjs'));
    const roster = new Roster({ local: true, wwwPath, minLocalPort: 19350, maxLocalPort: 19359 });
    t.after(() => roster.close().catch(() => {}));
    await roster.start();
    const { port } = new URL(roster.getUrl('loaded.example'));
    assert.equal(JSON.parse((await localGet(port)).body).pid, process.pid);
});

it('keeps every site in the main process when isolation is disabled', { timeout: 20000 }, async t => {
    const { wwwPath } = createWww(t, { 'shared.example': REPORT_SITE });
    const roster = new Roster({ local: true, wwwPath, isolation: false, minLocalPort: 19360, maxLocalPort: 19369 });
    t.after(() => roster.close().catch(() => {}));
    await roster.start();
    const { port } = new URL(roster.getUrl('shared.example'));
    assert.equal(JSON.parse((await localGet(port)).body).pid, process.pid);
});

it('rejects request plugins that cannot be recreated in isolated processes', { timeout: 20000 }, async t => {
    const { wwwPath } = createWww(t, { 'plugin.example': REPORT_SITE });
    const roster = new Roster({ local: true, wwwPath, minLocalPort: 19370, maxLocalPort: 19379 });
    t.after(() => roster.close().catch(() => {}));
    roster.use(function auditPlugin() { return false; });
    await assert.rejects(roster.start(), /auditPlugin cannot be recreated/);
});

function spawnMain(t, wwwPath, minLocalPort) {
    const script = `
        const http = require('node:http');
        const Roster = require(${JSON.stringify(require.resolve('../index.js'))});
        const roster = new Roster({ local: true, handleSignals: true, wwwPath: ${JSON.stringify(wwwPath)},
            minLocalPort: ${minLocalPort}, maxLocalPort: ${minLocalPort + 9} });
        roster.start().then(() => {
            http.get(roster.getUrl('hook.example'), res => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => process.send(Number(body)));
            });
        });
    `;
    const main = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    main.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => { if (main.exitCode === null && main.signalCode === null) main.kill('SIGKILL'); });
    return { main, stderr: () => stderr };
}

function hookSite(marker) {
    return `module.exports = server => {
        server.onClose(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'closed'));
        return (req, res) => res.end(String(process.pid));
    };`;
}

async function waitForExit(pid) {
    for (let attempt = 0; attempt < 100 && isRunning(pid); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return !isRunning(pid);
}

it('drains isolated sites on a signal sent to the whole process group', { timeout: 20000 }, async t => {
    const { root, wwwPath } = createWww(t, {});
    const marker = path.join(root, 'closed');
    createSite(wwwPath, 'hook.example', hookSite(marker));
    const { main, stderr } = spawnMain(t, wwwPath, 19380);
    const [sitePid] = await once(main, 'message');
    process.kill(sitePid, 'SIGTERM');
    main.kill('SIGTERM');
    const [code, signal] = await once(main, 'close');
    assert.equal(signal, null, stderr());
    assert.equal(code, 0, stderr());
    assert.equal(fs.readFileSync(marker, 'utf8'), 'closed');
    assert.equal(await waitForExit(sitePid), true);
});

it('closes isolated sites when the main process dies without closing', { timeout: 20000 }, async t => {
    const { root, wwwPath } = createWww(t, {});
    const marker = path.join(root, 'closed');
    createSite(wwwPath, 'hook.example', hookSite(marker));
    const { main } = spawnMain(t, wwwPath, 19390);
    const [sitePid] = await once(main, 'message');
    main.kill('SIGKILL');
    assert.equal(await waitForExit(sitePid), true);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'closed');
});

it('rejects combining isolation with the legacy cluster launcher', () => {
    assert.throws(() => new Roster({ cluster: true, isolation: true }), /cannot be combined/);
    assert.equal(new Roster({ cluster: true }).isolation, null);
});

it('extracts the SNI host from a ClientHello delivered in fragments', async t => {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const capture = async servername => {
        const accepted = once(server, 'connection');
        const client = tls.connect({ host: '127.0.0.1', port: server.address().port, servername, rejectUnauthorized: false });
        client.on('error', () => {});
        const [socket] = await accepted;
        const [hello] = await once(socket, 'data');
        client.destroy();
        socket.destroy();
        return hello;
    };
    const hello = await capture('Shop.Example.com');
    for (let length = 0; length < hello.length; length++) {
        assert.equal(parseClientHello(hello.subarray(0, length)), undefined);
    }
    assert.equal(parseClientHello(hello), 'shop.example.com');
    assert.equal(parseClientHello(await capture('')), null);
    assert.equal(parseClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n')), null);
});
