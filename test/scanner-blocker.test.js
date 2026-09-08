'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const Roster = require('../index.js');
const { createScannerBlocker } = require('../plugins/scanner-blocker.js');

function invoke(plugin, { url = '/', ip = '192.0.2.10', headers = {}, method = 'GET' } = {}) {
    let statusCode;
    let responseHeaders;
    let body;
    const req = {
        method,
        url,
        headers,
        socket: { remoteAddress: ip }
    };
    const res = {
        writeHead(code, nextHeaders) {
            statusCode = code;
            responseHeaders = nextHeaders;
        },
        end(nextBody) {
            body = nextBody;
        }
    };
    const handled = plugin(req, res, { host: 'example.com', domain: 'example.com' });
    return { handled, statusCode, responseHeaders, body };
}

function blocker(overrides = {}) {
    return createScannerBlocker({
        windowMs: 60_000,
        strikeThreshold: 2,
        banDurationMs: 300_000,
        maxTrackedClients: 100,
        trustProxy: false,
        ...overrides
    });
}

describe('scanner-blocker plugin', () => {
    it('uses documented defaults and permits individual overrides', () => {
        const plugin = createScannerBlocker();
        invoke(plugin, { url: '/wp-login.php' });
        invoke(plugin, { url: '/xmlrpc.php' });
        assert.strictEqual(invoke(plugin, { url: '/ordinary' }).handled, false);
        invoke(plugin, { url: '/install.php' });
        assert.strictEqual(invoke(plugin, { url: '/ordinary' }).handled, true);

        const overriddenPlugin = createScannerBlocker({ strikeThreshold: 1 });
        invoke(overriddenPlugin, { url: '/wp-login.php' });
        assert.strictEqual(invoke(overriddenPlugin, { url: '/ordinary' }).handled, true);

        assert.throws(() => createScannerBlocker(null), /options must be an object/);
        assert.throws(() => blocker({ trustProxy: 'false' }), /trustProxy/);
        assert.throws(() => blocker({ maxTrackedClients: 0 }), /maxTrackedClients/);
    });

    it('blocks PHP, WordPress, and sensitive-file probes', () => {
        const urls = [
            '/install.php',
            '/user-new\\.php',
            '/wp-login.php',
            '/wp-json',
            '/.git/config',
            '/%252eenv',
            '/security.txt'
        ];

        for (const [index, url] of urls.entries()) {
            const result = invoke(blocker(), { url, ip: `192.0.2.${index + 1}` });
            assert.strictEqual(result.handled, true, url);
            assert.strictEqual(result.statusCode, 404, url);
            assert.strictEqual(result.body, 'Not Found', url);
            assert.strictEqual(result.responseHeaders['Cache-Control'], 'no-store');
        }
    });

    it('does not classify ordinary article, atom, or config routes as scanner probes', () => {
        const plugin = blocker();
        assert.strictEqual(invoke(plugin, { url: '/en/an-article' }).handled, false);
        assert.strictEqual(invoke(plugin, { url: '/atom' }).handled, false);
        assert.strictEqual(invoke(plugin, { url: '/articles/config' }).handled, false);
    });

    it('bans a client after the configured number of probes', () => {
        const timestamp = 1_000;
        const events = [];
        const plugin = blocker({
            now: () => timestamp,
            onBlock: event => events.push(event)
        });

        assert.strictEqual(invoke(plugin, { url: '/wp-login.php' }).handled, true);
        assert.strictEqual(invoke(plugin, { url: '/xmlrpc.php' }).handled, true);
        assert.strictEqual(invoke(plugin, { url: '/legitimate-page' }).handled, true);
        assert.strictEqual(events[1].bannedUntil, 301_000);
        assert.strictEqual(events[2].type, 'banned-client');

        assert.strictEqual(invoke(plugin, { url: '/legitimate-page', ip: '192.0.2.11' }).handled, false);
    });

    it('expires bans without extending them on blocked requests', () => {
        let timestamp = 1_000;
        const events = [];
        const plugin = blocker({
            strikeThreshold: 1,
            banDurationMs: 5_000,
            now: () => timestamp,
            onBlock: event => events.push(event)
        });

        invoke(plugin, { url: '/wp-login.php' });
        assert.strictEqual(events[0].bannedUntil, 6_000);
        timestamp = 5_999;
        assert.strictEqual(invoke(plugin, { url: '/ordinary' }).handled, true);
        timestamp = 6_000;
        assert.strictEqual(invoke(plugin, { url: '/ordinary' }).handled, false);
    });

    it('trusts X-Forwarded-For only when explicitly configured', () => {
        const headers = { 'x-forwarded-for': '198.51.100.1, 198.51.100.2' };
        const directPlugin = blocker({ strikeThreshold: 1, trustProxy: false });
        invoke(directPlugin, { url: '/install.php', headers, ip: '192.0.2.20' });
        assert.strictEqual(invoke(directPlugin, { url: '/', headers, ip: '192.0.2.20' }).handled, true);
        assert.strictEqual(invoke(directPlugin, { url: '/', headers, ip: '192.0.2.21' }).handled, false);

        const proxyPlugin = blocker({ strikeThreshold: 1, trustProxy: true });
        invoke(proxyPlugin, { url: '/install.php', headers, ip: '192.0.2.20' });
        assert.strictEqual(invoke(proxyPlugin, { url: '/', headers, ip: '192.0.2.21' }).handled, true);
    });

    it('keeps tracked client state within the configured bound', () => {
        const plugin = blocker({ maxTrackedClients: 1 });
        invoke(plugin, { url: '/install.php', ip: '192.0.2.30' });
        invoke(plugin, { url: '/install.php', ip: '192.0.2.31' });
        invoke(plugin, { url: '/xmlrpc.php', ip: '192.0.2.30' });
        assert.strictEqual(invoke(plugin, { url: '/ordinary', ip: '192.0.2.30' }).handled, false);
    });

    it('does not send a response body for HEAD probes', () => {
        const result = invoke(blocker(), { method: 'HEAD', url: '/wp-login.php' });
        assert.strictEqual(result.handled, true);
        assert.strictEqual(result.body, undefined);
    });
});

describe('Roster request plugins', () => {
    it('runs plugins before dispatching to the site handler', async () => {
        let siteRequests = 0;
        const roster = new Roster({ local: true });
        roster.use(createScannerBlocker({
            windowMs: 60_000,
            strikeThreshold: 2,
            banDurationMs: 300_000,
            maxTrackedClients: 100,
            trustProxy: false
        }));
        roster.register('example.com', () => (req, res) => {
            siteRequests += 1;
            res.writeHead(200);
            res.end('site');
        });
        await roster.init();

        const handler = roster.requestHandler();
        const probe = invoke(handler, {
            url: '/wp-login.php',
            headers: { host: 'example.com' }
        });
        assert.strictEqual(probe.statusCode, 404);
        assert.strictEqual(siteRequests, 0);

        const ordinary = invoke(handler, {
            url: '/ordinary',
            ip: '192.0.2.11',
            headers: { host: 'example.com' }
        });
        assert.strictEqual(ordinary.statusCode, 200);
        assert.strictEqual(ordinary.body, 'site');
        assert.strictEqual(siteRequests, 1);
    });

    it('validates plugins and rejects asynchronous request plugins', async () => {
        const roster = new Roster({ local: true });
        assert.throws(() => roster.use({}), /plugin must be a function/);
        assert.strictEqual(roster.use(() => false), roster);

        const asyncRoster = new Roster({ local: true });
        asyncRoster.use(async () => false);
        asyncRoster.register('example.com', () => () => {});
        await asyncRoster.init();
        const result = invoke(asyncRoster.requestHandler(), { headers: { host: 'example.com' } });
        assert.strictEqual(result.statusCode, 500);
        assert.strictEqual(result.body, 'Internal Server Error');
    });
});
