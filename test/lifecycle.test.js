'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const Roster = require('../index.js');

function createRoster(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-lifecycle-'));
    const roster = new Roster({ local: true, wwwPath: directory, ...options });
    t.after(async () => {
        await roster.close().catch(() => {});
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return roster;
}

async function serve(t, roster) {
    await roster.init();
    const server = http.createServer();
    roster.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    return server;
}

function request(server, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: server.address().address, port: server.address().port, agent: false,
            headers: { host: 'example.com' }, ...options
        }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

it('shares initialization and runs each factory once', async t => {
    const roster = createRoster(t);
    let calls = 0;
    roster.register('example.com', () => { calls++; return (req, res) => res.end('ok'); });
    const first = roster.init();
    assert.equal(first, roster.init());
    await first;
    assert.equal(calls, 1);
});

it('cleans initialized sites when a subsequent factory throws', async t => {
    const roster = createRoster(t);
    let cleaned = false;
    roster.register('example.com', server => {
        server.onClose(async () => { await Promise.resolve(); cleaned = true; });
        return () => {};
    });
    roster.register('broken.example.com', () => { throw new Error('factory failed'); });
    await assert.rejects(roster.init(), /factory failed/);
    assert.equal(cleaned, true);
});

it('waits for listening, shares start, and closes owned servers once', async t => {
    const roster = createRoster(t);
    roster.assignPortToDomain = () => 0;
    let closed = 0;
    roster.register('example.com', server => {
        server.onClose(() => { closed++; });
        return (req, res) => res.end('ok');
    });
    const start = roster.start();
    assert.equal(start, roster.start());
    await start;
    const server = roster.portServers[0];
    assert.equal(server.listening, true);
    assert.equal((await request(server)).body, 'ok');
    const closing = roster.close();
    assert.equal(closing, roster.close());
    await closing;
    assert.equal(server.listening, false);
    assert.equal(closed, 1);
    await assert.rejects(roster.start(), /closing or closed/);
});

it('rejects bind failures and rolls back already opened ports', async t => {
    const blocker = http.createServer();
    await new Promise(resolve => blocker.listen(0, 'localhost', resolve));
    t.after(() => new Promise(resolve => blocker.close(resolve)));
    const roster = createRoster(t);
    const ports = [0, blocker.address().port];
    roster.assignPortToDomain = () => ports.shift();
    let cleaned = 0;
    for (const domain of ['example.com', 'second.example.com']) {
        roster.register(domain, server => {
            server.onClose(() => { cleaned++; });
            return () => {};
        });
    }
    await assert.rejects(roster.start(), { code: 'EADDRINUSE' });
    assert.equal(roster.portServers[0].listening, false);
    assert.equal(cleaned, 2);
});

it('close during initialization prevents factories from starting', async t => {
    const roster = createRoster(t);
    let release;
    roster.loadSites = () => new Promise(resolve => { release = resolve; });
    let called = false;
    roster.register('example.com', () => { called = true; });
    const initializing = roster.init();
    const rejected = assert.rejects(initializing, /closing or closed/);
    const closing = roster.close();
    release();
    await Promise.all([rejected, closing]);
    assert.equal(called, false);
});

it('drains active HTTP before cleanup and preserves external server ownership', async t => {
    const roster = createRoster(t);
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let cleaned = false;
    roster.register('example.com', server => {
        server.onClose(() => { cleaned = true; });
        return async (req, res) => {
            entered();
            await new Promise(resolve => { release = resolve; });
            assert.equal(cleaned, false);
            res.end('drained');
        };
    });
    const server = await serve(t, roster);
    const pending = request(server);
    await started;
    const closing = roster.close();
    assert.equal((await request(server)).status, 503);
    assert.equal(cleaned, false);
    release();
    assert.equal((await pending).body, 'drained');
    await closing;
    assert.equal(cleaned, true);
    assert.equal(server.listening, true);
    assert.equal(server.listenerCount('request'), 0);
    server.on('request', (req, res) => res.end('external'));
    assert.equal((await request(server)).body, 'external');
});

it('runs all async hooks and aggregates errors', async t => {
    const roster = createRoster(t);
    const calls = [];
    roster.register('example.com', server => {
        server.onClose(() => { calls.push('first'); throw new Error('cleanup failed'); });
        server.onClose(async () => { await Promise.resolve(); calls.push('second'); });
        return () => {};
    });
    await roster.init();
    await assert.rejects(roster.close(), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0].message, 'cleanup failed');
        return true;
    });
    assert.deepEqual(calls, ['first', 'second']);
});

it('notifies virtual servers before draining long polling requests', async t => {
    const roster = createRoster(t, { closeTimeoutMs: 1000 });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let pendingResponse;
    let cleaned = false;
    roster.register('example.com', virtual => {
        virtual.on('close', () => pendingResponse.end('poll closed'));
        virtual.onClose(() => { cleaned = true; });
        return (req, res) => { pendingResponse = res; entered(); };
    });
    const server = await serve(t, roster);
    const pending = request(server);
    await started;
    await roster.close();
    assert.equal((await pending).body, 'poll closed');
    assert.equal(cleaned, true);
});

it('bounds a hanging cleanup hook', async t => {
    const roster = createRoster(t, { closeTimeoutMs: 20 });
    roster.register('example.com', server => {
        server.onClose(() => new Promise(() => {}));
        return () => {};
    });
    await roster.init();
    await assert.rejects(roster.close(), error => error.errors.some(item => /timed out/.test(item.message)));
});

it('forces a stalled request closed at the deadline and still runs cleanup', async t => {
    const roster = createRoster(t, { closeTimeoutMs: 30 });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let cleaned = false;
    roster.register('example.com', server => {
        server.onClose(() => { cleaned = true; });
        return () => entered();
    });
    const server = await serve(t, roster);
    const pending = assert.rejects(request(server));
    await started;
    await assert.rejects(roster.close(), error => error.errors.some(item => /timed out/.test(item.message)));
    await pending;
    assert.equal(cleaned, true);
});

it('closes upgraded sockets without closing an attached server', async t => {
    const roster = createRoster(t);
    let upgraded;
    const ready = new Promise(resolve => { upgraded = resolve; });
    roster.register('example.com', server => {
        server.on('upgrade', (req, socket) => {
            socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
            upgraded();
        });
        return (req, res) => res.end('ok');
    });
    const server = await serve(t, roster);
    const client = net.connect(server.address().port, '127.0.0.1');
    client.on('error', () => {});
    client.resume();
    t.after(() => client.destroy());
    await once(client, 'connect');
    client.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
    await ready;
    const closed = once(client, 'close');
    await roster.close();
    await closed;
    assert.equal(server.listening, true);
});

it('does not fall back while an asynchronous request listener is responding', async t => {
    const roster = createRoster(t);
    roster.register('example.com', server => {
        server.on('request', (req, res) => { setImmediate(() => res.end('async listener')); });
        return (req, res) => res.end('wrong fallback');
    });
    const server = await serve(t, roster);
    assert.equal((await request(server)).body, 'async listener');
});

it('allows Socket.IO-style wrappers to capture the returned HTTP fallback', async t => {
    const roster = createRoster(t);
    roster.register('example.com', server => {
        const listeners = server.listeners('request');
        server.removeAllListeners('request');
        server.on('request', (req, res) => {
            if (req.url === '/socket.io') setImmediate(() => res.end('socket'));
            else listeners.forEach(listener => listener(req, res));
        });
        return async (req, res) => { await Promise.resolve(); res.end('http fallback'); };
    });
    const server = await serve(t, roster);
    assert.equal((await request(server, { path: '/socket.io' })).body, 'socket');
    assert.equal((await request(server, { path: '/' })).body, 'http fallback');
});

it('handles rejected and thrown request errors without bringing down other sites', async t => {
    const roster = createRoster(t);
    roster.register('example.com', () => async () => { throw new Error('async failure'); });
    roster.register('other.example.com', () => () => { throw new Error('sync failure'); });
    const server = await serve(t, roster);
    assert.equal((await request(server)).status, 500);
    assert.equal((await request(server, { headers: { host: 'other.example.com' } })).status, 500);
});

it('aborts a partially written response on rejection and keeps other sites available', { timeout: 5000 }, async t => {
    const roster = createRoster(t);
    let release;
    const fail = new Promise(resolve => { release = resolve; });
    roster.register('example.com', () => async (req, res) => {
        res.write('partial');
        await fail;
        throw new Error('streaming handler failed');
    });
    roster.register('healthy.example.com', () => (req, res) => res.end('healthy'));
    const server = await serve(t, roster);
    await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: server.address().port,
            headers: { host: 'example.com' }, agent: false }, res => {
            assert.equal(res.statusCode, 200);
            res.once('data', () => release());
            res.once('aborted', resolve);
            res.once('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
            res.once('end', () => reject(new Error('Partial response must not complete successfully')));
        }).on('error', reject);
    });
    assert.equal((await request(server, { headers: { host: 'healthy.example.com' } })).body, 'healthy');
});

it('closes every virtual server when the same domain is registered on multiple ports', async t => {
    const roster = createRoster(t);
    const closed = [];
    const cleaned = [];
    for (const port of [443, 8880, 8882]) {
        roster.register(`example.com:${port}`, virtual => {
            virtual.on('close', () => closed.push(port));
            virtual.onClose(async () => { await Promise.resolve(); cleaned.push(port); });
            return () => {};
        });
    }
    await roster.init();
    await Promise.all([roster.close(), roster.close()]);
    assert.deepEqual(closed.sort((a, b) => a - b), [443, 8880, 8882]);
    assert.deepEqual(cleaned.sort((a, b) => a - b), [443, 8880, 8882]);
});

it('preserves initialization and cleanup errors when both fail', async t => {
    const roster = createRoster(t);
    const cleanupError = new Error('cleanup failed');
    const initError = new Error('factory failed');
    roster.register('example.com', virtual => {
        virtual.onClose(() => { throw cleanupError; });
        return () => {};
    });
    roster.register('broken.example.com', () => { throw initError; });
    await assert.rejects(roster.init(), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], initError);
        assert.deepEqual(error.errors[1].errors, [cleanupError]);
        return true;
    });
});

it('cancels a pending listen without opening a port when DNS resolves after shutdown', { timeout: 5000 }, async t => {
    const dns = require('node:dns');
    let resolveLookup;
    t.mock.method(dns, 'lookup', (hostname, options, callback) => { resolveLookup = callback; });
    const roster = createRoster(t);
    const server = http.createServer();
    t.after(() => { server.close(); server.closeAllConnections(); });
    const listening = assert.rejects(roster._listen(server, 0, 'pending.test'), /closing or closed/);
    await roster.close();
    await listening;
    resolveLookup(null, '127.0.0.1', 4);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(server.listening, false);
    assert.equal(server.address(), null);
});

it('preserves the custom port in www redirects', async t => {
    const roster = createRoster(t);
    roster.register('example.com', () => () => {});
    const server = await serve(t, roster);
    const response = await request(server, { headers: { host: 'www.example.com:8880' }, path: '/test' });
    assert.equal(response.headers.location, 'http://example.com:8880/test');
});

it('attaches once and rejects conflicting port attachments', async t => {
    const roster = createRoster(t);
    roster.register('example.com', () => () => {});
    const server = await serve(t, roster);
    roster.attach(server);
    assert.equal(server.listenerCount('request'), 1);
    assert.equal(server.listenerCount('upgrade'), 1);
    assert.throws(() => roster.attach(server, { port: 8880 }), /another port/);
});

it('supports virtual close callbacks and close events exactly once', async t => {
    const roster = createRoster(t);
    const server = roster.createVirtualServer('example.com');
    let events = 0;
    server.on('close', () => { events++; });
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => server.close(resolve));
    assert.equal(events, 1);
});

it('cancels renewal and retry timers on close', async t => {
    const roster = createRoster(t);
    roster.register('example.com', () => () => {});
    await roster.init();
    let calls = 0;
    roster._greenlockRuntime = { get: async () => { calls++; } };
    roster.certificateRenewIntervalMs = 10;
    roster._startCertificateRenewLoop();
    roster._retryTimers.add(setTimeout(() => { calls++; }, 10));
    await roster.close();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(calls, 0);
    assert.equal(roster._retryTimers.size, 0);
});

it('rejects an exhausted local port range instead of looping indefinitely', t => {
    const roster = createRoster(t, { minLocalPort: 19000, maxLocalPort: 19000 });
    roster.assignPortToDomain('example.com');
    assert.throws(() => roster.assignPortToDomain('other.example.com'), /exhausted/);
});

it('handles errors from virtual listeners and invalid async plugins', async t => {
    const roster = createRoster(t);
    roster.register('example.com', server => {
        server.on('request', async () => { throw new Error('listener failed'); });
    });
    const server = await serve(t, roster);
    assert.equal((await request(server)).status, 500);
    roster.use(async () => { throw new Error('invalid plugin'); });
    assert.equal((await request(server)).status, 500);
});

it('uses one certificate runtime and waits for production listeners', async t => {
    const shim = require('../vendor/greenlock-express/greenlock-shim.js');
    const greenlock = require('../vendor/greenlock-express/greenlock-express.js');
    const roster = createRoster(t, { local: false });
    roster.greenlockStorePath = path.join(roster.wwwPath, 'certificates');
    let creates = 0;
    const runtime = { get: async () => null };
    t.mock.method(shim, 'create', options => {
        assert.equal(options.renew, false);
        creates++;
        return runtime;
    });
    const acme = http.createServer();
    t.mock.method(greenlock, 'init', options => {
        assert.equal(options.greenlock, runtime);
        return {
            ready(callback) {
                setImmediate(() => callback({
                    httpServer: () => acme,
                    httpsServer: (options, handler) => http.createServer(handler)
                }));
                return this;
            }
        };
    });
    const listen = roster._listen.bind(roster);
    roster._listen = server => listen(server, 0, '127.0.0.1');
    roster.register('example.com', () => (req, res) => res.end('production route'));
    await roster.start();
    assert.equal(creates, 1);
    assert.equal(acme.listening, true);
    assert.equal(roster.portServers[443].listening, true);
    assert.equal((await request(roster.portServers[443])).body, 'production route');
    await roster.close();
    assert.equal(acme.listening, false);
    assert.equal(roster.portServers[443].listening, false);
});

it('propagates an ACME listener bind failure through the real Greenlock adapter', async t => {
    const shim = require('../vendor/greenlock-express/greenlock-shim.js');
    t.mock.method(shim, 'create', options => options.greenlock || { get: async () => null });
    const exit = t.mock.method(process, 'exit', () => { throw new Error('Unexpected process.exit'); });
    const blocker = http.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => blocker.close(resolve)));
    const roster = createRoster(t, { local: false });
    roster.greenlockStorePath = path.join(roster.wwwPath, 'certificates');
    roster.register('example.com', () => () => {});
    const listen = roster._listen.bind(roster);
    roster._listen = server => listen(server, blocker.address().port, '127.0.0.1');
    await assert.rejects(roster.start(), { code: 'EADDRINUSE' });
    assert.equal(exit.mock.callCount(), 0);
    assert.equal(roster._certificateRenewTimer, null);
});
