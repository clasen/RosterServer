'use strict';

// Greenlock's ACME client must complete HTTP exchanges on Node and Bun: run with `pnpm test` and `pnpm test:bun`.
const { it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Greenlock = require('../vendor/greenlock/greenlock.js');

let server;
let directoryUrl;
let packageRoot;
before(async () => {
    packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-acme-request-'));
    server = http.createServer((req, res) => {
        const base = `http://127.0.0.1:${server.address().port}`;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Replay-Nonce': 'nonce-1' });
        res.end(JSON.stringify({
            newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order`,
            revokeCert: `${base}/revoke`, keyChange: `${base}/key`, meta: { termsOfService: `${base}/tos` }
        }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    directoryUrl = `http://127.0.0.1:${server.address().port}/directory`;
});
after(() => {
    server.close();
    fs.rmSync(packageRoot, { recursive: true, force: true });
});

it('reads the ACME directory without touching the sent request headers', async () => {
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'acme-request-test', version: '1.0.0' }));
    const greenlock = Greenlock.create({
        packageRoot,
        configDir: path.join(packageRoot, 'greenlock.d'),
        maintainerEmail: 'ops@example.com',
        renew: false,
        notify() {}
    });
    const acme = await greenlock._acme({}, {}, directoryUrl);
    assert.equal(acme._tos, `http://127.0.0.1:${server.address().port}/tos`);
});
