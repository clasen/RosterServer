'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Writable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { createStaticHandler } = require('../lib/static-site-handler.js');
const Roster = require('../index.js');

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-files-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function response() {
    const chunks = [];
    const res = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
    return { res, body: () => Buffer.concat(chunks) };
}

it('streams a static file without synchronous filesystem calls', async t => {
    const root = temporaryDirectory(t);
    const content = Buffer.alloc(1024 * 1024, 'a');
    fs.writeFileSync(path.join(root, 'index.html'), content);
    const handler = createStaticHandler(root)();
    const result = response();
    for (const method of ['readFileSync', 'statSync', 'existsSync']) {
        t.mock.method(fs, method, () => { throw new Error(`Unexpected ${method}`); });
    }
    await handler({ method: 'GET', url: '/' }, result.res);
    assert.equal(result.res.status, 200);
    assert.equal(result.res.headers['Content-Length'], content.length);
    assert.deepEqual(result.body(), content);
});

it('serves HEAD using metadata without reading file contents', async t => {
    const root = temporaryDirectory(t);
    fs.writeFileSync(path.join(root, 'index.html'), 'head content');
    const open = fs.promises.open.bind(fs.promises);
    t.mock.method(fs.promises, 'open', async (...args) => {
        const file = await open(...args);
        file.createReadStream = () => { throw new Error('HEAD must not stream'); };
        file.readFile = () => { throw new Error('HEAD must not read'); };
        return file;
    });
    const result = response();
    await createStaticHandler(root)()({ method: 'HEAD', url: '/' }, result.res);
    assert.equal(result.res.status, 200);
    assert.equal(result.res.headers['Content-Length'], 12);
    assert.equal(result.body().length, 0);
});

it('handles directory indexes, missing files, and an open race', async t => {
    const root = temporaryDirectory(t);
    fs.mkdirSync(path.join(root, 'en'));
    fs.writeFileSync(path.join(root, 'en', 'index.html'), 'directory');
    const handler = createStaticHandler(root)();
    const directory = response();
    await handler({ method: 'GET', url: '/en/?a=b' }, directory.res);
    assert.equal(directory.body().toString(), 'directory');
    const missing = response();
    await handler({ method: 'GET', url: '/missing' }, missing.res);
    assert.equal(missing.res.status, 404);
    t.mock.method(fs.promises, 'open', async () => { throw Object.assign(new Error('removed'), { code: 'ENOENT' }); });
    const removed = response();
    await handler({ method: 'GET', url: '/en/' }, removed.res);
    assert.equal(removed.res.status, 404);
});

it('closes static file handles when the client disconnects mid-stream', async t => {
    const root = temporaryDirectory(t);
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(8 * 1024 * 1024));
    const handler = createStaticHandler(root)();
    const handles = [];
    const open = fs.promises.open.bind(fs.promises);
    t.mock.method(fs.promises, 'open', async (...args) => {
        const file = await open(...args);
        handles.push(file);
        return file;
    });
    let handled;
    const complete = new Promise(resolve => { handled = resolve; });
    const server = http.createServer((req, res) => {
        handler(req, res).then(handled);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    await new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/large.bin' }, res => {
            res.once('data', () => { res.destroy(); resolve(); });
        });
        req.on('error', reject);
    });
    await complete;
    assert.equal(handles.length, 1);
    assert.equal(handles[0].fd, -1);
});

it('rejects non-regular files before opening them', async t => {
    const root = temporaryDirectory(t);
    t.mock.method(fs.promises, 'stat', async () => ({ isDirectory: () => false, isFile: () => false }));
    t.mock.method(fs.promises, 'open', () => { throw new Error('Must not open special files'); });
    const result = response();
    await createStaticHandler(root)()({ method: 'GET', url: '/pipe' }, result.res);
    assert.equal(result.res.status, 404);
});

it('maps filesystem failures to HTTP errors without exposing internal details', async t => {
    const root = temporaryDirectory(t);
    fs.writeFileSync(path.join(root, 'index.html'), 'content');
    for (const method of ['stat', 'open']) {
        for (const [code, status, body] of [
            ['ENOTDIR', 404, 'Not Found'],
            ['EACCES', 403, 'Forbidden'],
            ['EIO', 500, 'Internal Server Error']
        ]) {
            await t.test(`${method}: ${code}`, async t => {
                t.mock.method(fs.promises, method, async () => {
                    throw Object.assign(new Error('internal filesystem detail'), { code });
                });
                const result = response();
                await createStaticHandler(root)()({ method: 'GET', url: '/' }, result.res);
                assert.equal(result.res.status, status);
                assert.equal(result.body().toString(), body);
            });
        }
    }
});

it('uses opened-file metadata and closes the handle when the file changes before open', async t => {
    const root = temporaryDirectory(t);
    fs.writeFileSync(path.join(root, 'index.html'), 'old');
    const open = fs.promises.open.bind(fs.promises);
    let handle;
    t.mock.method(fs.promises, 'open', async (...args) => {
        fs.writeFileSync(path.join(root, 'index.html'), 'replacement content');
        handle = await open(...args);
        return handle;
    });
    const result = response();
    await createStaticHandler(root)()({ method: 'GET', url: '/' }, result.res);
    assert.equal(result.res.headers['Content-Length'], Buffer.byteLength('replacement content'));
    assert.equal(result.body().toString(), 'replacement content');
    assert.equal(handle.fd, -1);
});

it('closes opened files if fstat fails or finds a non-regular replacement', async t => {
    const root = temporaryDirectory(t);
    fs.writeFileSync(path.join(root, 'index.html'), 'content');
    const open = fs.promises.open.bind(fs.promises);
    for (const fail of [false, true]) {
        await t.test(fail ? 'fstat failure' : 'non-regular replacement', async t => {
            let handle;
            t.mock.method(fs.promises, 'open', async (...args) => {
                handle = await open(...args);
                t.mock.method(handle, 'stat', async () => {
                    if (fail) throw Object.assign(new Error('stat failed'), { code: 'EIO' });
                    return { isFile: () => false };
                });
                return handle;
            });
            const result = response();
            await createStaticHandler(root)()({ method: 'GET', url: '/' }, result.res);
            assert.equal(result.res.status, fail ? 500 : 404);
            assert.equal(handle.fd, -1);
        });
    }
});

it('closes a file opened after its response was already destroyed', async t => {
    const root = temporaryDirectory(t);
    fs.writeFileSync(path.join(root, 'index.html'), 'content');
    const result = response();
    const open = fs.promises.open.bind(fs.promises);
    let handle;
    t.mock.method(fs.promises, 'open', async (...args) => {
        result.res.destroy();
        handle = await open(...args);
        return handle;
    });
    await createStaticHandler(root)()({ method: 'GET', url: '/' }, result.res);
    assert.equal(result.res.headersSent, undefined);
    assert.equal(handle.fd, -1);
});

it('reuses TLS contexts, coalesces concurrent loads, and reloads changed certificates', async t => {
    const root = temporaryDirectory(t);
    const directory = path.join(root, 'live', 'example.com');
    fs.mkdirSync(directory, { recursive: true });
    const key = path.join(directory, 'privkey.pem');
    const cert = path.join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
        '-out', cert, '-subj', '/CN=example.com', '-days', '1'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(directory, 'chain.pem'), '');
    const roster = new Roster({ local: true, wwwPath: root, greenlockStorePath: root });
    t.after(() => roster.close());
    const read = fs.promises.readFile.bind(fs.promises);
    let reads = 0;
    t.mock.method(fs.promises, 'readFile', (...args) => { reads++; return read(...args); });
    const contexts = await Promise.all(Array.from({ length: 8 }, () => roster._resolveSecureContext('example.com')));
    assert.ok(contexts[0]);
    assert.ok(contexts.every(context => context === contexts[0]));
    assert.equal(reads, 3);
    assert.equal(await roster._resolveSecureContext('example.com'), contexts[0]);
    assert.equal(reads, 3);
    execFileSync('openssl', ['req', '-x509', '-key', key, '-out', cert,
        '-subj', '/CN=example.com', '-days', '1', '-set_serial', '2'], { stdio: 'ignore' });
    assert.notEqual(await roster._resolveSecureContext('example.com'), contexts[0]);
    assert.equal(reads, 6);
    fs.unlinkSync(cert);
    assert.equal(await roster._resolveSecureContext('example.com'), null);
    assert.equal(roster._secureContexts.size, 0);
});

it('coalesces certificate checks and prevents new issuance after close', async t => {
    const root = temporaryDirectory(t);
    const roster = new Roster({ local: true, wwwPath: root });
    let calls = 0;
    let release;
    roster._greenlockRuntime = { get: () => { calls++; return new Promise(resolve => { release = resolve; }); } };
    const first = roster._checkCertificate('example.com');
    assert.equal(first, roster._checkCertificate('example.com'));
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    await first;
    assert.equal(roster._certificateChecks.size, 0);
    await roster.close();
    assert.throws(() => roster._checkCertificate('example.com'), /closing or closed/);
});

it('waits for in-flight certificate work before running close hooks', async t => {
    const root = temporaryDirectory(t);
    const roster = new Roster({ local: true, wwwPath: root });
    t.after(() => roster.close());
    let cleaned = false;
    roster.register('example.com', virtual => {
        virtual.onClose(() => { cleaned = true; });
        return () => {};
    });
    await roster.init();
    let release;
    roster._greenlockRuntime = { get: () => new Promise(resolve => { release = resolve; }) };
    const check = roster._checkCertificate('example.com');
    await Promise.resolve();
    const closing = roster.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cleaned, false);
    release();
    await Promise.all([check, closing]);
    assert.equal(cleaned, true);
});

it('does not repopulate TLS caches when close interrupts a context load', async t => {
    const root = temporaryDirectory(t);
    const roster = new Roster({ local: true, wwwPath: root });
    t.after(() => roster.close());
    let release;
    const pendingStat = new Promise(resolve => { release = resolve; });
    t.mock.method(fs.promises, 'stat', () => pendingStat);
    const loading = assert.rejects(roster._resolveSecureContext('example.com'), /closing or closed/);
    const closing = roster.close();
    release({});
    await Promise.all([loading, closing]);
    assert.equal(roster._contextLoads.size, 0);
    assert.equal(roster._secureContexts.size, 0);
});
