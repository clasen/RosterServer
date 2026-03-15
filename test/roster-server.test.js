'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const Roster = require('../index.js');
const {
    wildcardRoot,
    hostMatchesWildcard,
    wildcardSubjectForHost,
    buildCertLookupCandidates
} = require('../index.js');

function closePortServers(roster) {
    if (roster.portServers && typeof roster.portServers === 'object') {
        for (const server of Object.values(roster.portServers)) {
            try {
                server.close();
            } catch (_) {}
        }
    }
}

function httpGet(host, port, pathname = '/') {
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host, port, path: pathname, headers: { host: host + (port === 80 ? '' : ':' + port) } },
            (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
            }
        );
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

describe('wildcardRoot', () => {
    it('returns root domain for *.example.com', () => {
        assert.strictEqual(wildcardRoot('*.example.com'), 'example.com');
    });
    it('returns root for *.sub.example.com', () => {
        assert.strictEqual(wildcardRoot('*.sub.example.com'), 'sub.example.com');
    });
    it('returns null for non-wildcard', () => {
        assert.strictEqual(wildcardRoot('example.com'), null);
        assert.strictEqual(wildcardRoot('api.example.com'), null);
    });
    it('returns null for empty or null', () => {
        assert.strictEqual(wildcardRoot(''), null);
        assert.strictEqual(wildcardRoot(null), null);
    });
});

describe('hostMatchesWildcard', () => {
    it('matches subdomain to pattern', () => {
        assert.strictEqual(hostMatchesWildcard('api.example.com', '*.example.com'), true);
        assert.strictEqual(hostMatchesWildcard('app.example.com', '*.example.com'), true);
        assert.strictEqual(hostMatchesWildcard('a.example.com', '*.example.com'), true);
    });
    it('does not match apex domain', () => {
        assert.strictEqual(hostMatchesWildcard('example.com', '*.example.com'), false);
    });
    it('does not match other zones', () => {
        assert.strictEqual(hostMatchesWildcard('api.other.com', '*.example.com'), false);
        assert.strictEqual(hostMatchesWildcard('example.com.evil.com', '*.example.com'), false);
    });
    it('returns false for invalid pattern', () => {
        assert.strictEqual(hostMatchesWildcard('api.example.com', 'example.com'), false);
        assert.strictEqual(hostMatchesWildcard('api.example.com', ''), false);
        assert.strictEqual(hostMatchesWildcard('api.example.com', null), false);
    });
    it('matches case-insensitively (Host header may be any case)', () => {
        assert.strictEqual(hostMatchesWildcard('Admin.Tagnu.com', '*.tagnu.com'), true);
        assert.strictEqual(hostMatchesWildcard('API.EXAMPLE.COM', '*.example.com'), true);
    });
});

describe('wildcardSubjectForHost', () => {
    it('returns wildcard subject for subdomain hosts', () => {
        assert.strictEqual(wildcardSubjectForHost('admin.tagnu.com'), '*.tagnu.com');
        assert.strictEqual(wildcardSubjectForHost('api.eu.example.com'), '*.eu.example.com');
    });
    it('returns null for apex hosts', () => {
        assert.strictEqual(wildcardSubjectForHost('tagnu.com'), null);
        assert.strictEqual(wildcardSubjectForHost('localhost'), null);
    });
});

describe('buildCertLookupCandidates', () => {
    it('prioritizes wildcard cert for subdomains and includes apex fallback', () => {
        assert.deepStrictEqual(
            buildCertLookupCandidates('admin.tagnu.com'),
            ['admin.tagnu.com', '*.tagnu.com', '_wildcard_.tagnu.com', 'tagnu.com']
        );
    });
    it('includes wildcard storage path candidates when wildcard subject is provided', () => {
        assert.deepStrictEqual(
            buildCertLookupCandidates('*.tagnu.com'),
            ['*.tagnu.com', '_wildcard_.tagnu.com', 'tagnu.com']
        );
    });
    it('returns only apex subject for apex hosts', () => {
        assert.deepStrictEqual(buildCertLookupCandidates('tagnu.com'), ['tagnu.com']);
    });
});

describe('Roster', () => {
    describe('parseDomainWithPort', () => {
        it('parses *.example.com with default port', () => {
            const roster = new Roster({ local: true });
            assert.deepStrictEqual(roster.parseDomainWithPort('*.example.com'), {
                domain: '*.example.com',
                port: 443
            });
        });
        it('parses *.example.com:8080', () => {
            const roster = new Roster({ local: true });
            assert.deepStrictEqual(roster.parseDomainWithPort('*.example.com:8080'), {
                domain: '*.example.com',
                port: 8080
            });
        });
        it('parses normal domain with port', () => {
            const roster = new Roster({ local: true });
            assert.deepStrictEqual(roster.parseDomainWithPort('example.com:8443'), {
                domain: 'example.com',
                port: 8443
            });
        });
    });

    describe('register (wildcard)', () => {
        it('registers *.example.com and resolves handler for subdomain', () => {
            const roster = new Roster({ local: true });
            const handler = () => {};
            roster.register('*.example.com', handler);
            assert.strictEqual(roster.getHandlerForHost('api.example.com'), handler);
            assert.strictEqual(roster.getHandlerForHost('app.example.com'), handler);
            assert.strictEqual(roster.getHandlerForHost('example.com'), null);
            assert.ok(roster.wildcardZones.has('example.com'));
        });
        it('registers *.example.com:8080 with custom port', () => {
            const roster = new Roster({ local: true });
            const handler = () => {};
            roster.register('*.example.com:8080', handler);
            assert.strictEqual(roster.sites['*.example.com:8080'], handler);
            assert.ok(roster.wildcardZones.has('example.com'));
        });
        it('getHandlerAndKeyForHost returns handler and siteKey for wildcard match', () => {
            const roster = new Roster({ local: true });
            const handler = () => {};
            roster.register('*.example.com', handler);
            const resolved = roster.getHandlerAndKeyForHost('api.example.com');
            assert.ok(resolved);
            assert.strictEqual(resolved.handler, handler);
            assert.strictEqual(resolved.siteKey, '*.example.com');
        });
        it('exact match takes precedence over wildcard', () => {
            const roster = new Roster({ local: true });
            const exactHandler = () => {};
            const wildcardHandler = () => {};
            roster.register('api.example.com', exactHandler);
            roster.register('*.example.com', wildcardHandler);
            assert.strictEqual(roster.getHandlerForHost('api.example.com'), exactHandler);
        });
        it('ignores wildcard registration when disableWildcard is true', () => {
            const roster = new Roster({ local: true, disableWildcard: true });
            const handler = () => {};
            roster.register('*.example.com', handler);
            assert.strictEqual(roster.sites['*.example.com'], undefined);
            assert.strictEqual(roster.getHandlerForHost('api.example.com'), null);
            assert.strictEqual(roster.wildcardZones.has('example.com'), false);
        });
    });

    describe('getHandlerForPortData', () => {
        it('returns exact match when present', () => {
            const roster = new Roster({ local: true });
            const vs = roster.createVirtualServer('example.com');
            const handler = () => {};
            const portData = {
                virtualServers: { 'example.com': vs },
                appHandlers: { 'example.com': handler }
            };
            const resolved = roster.getHandlerForPortData('example.com', portData);
            assert.ok(resolved);
            assert.strictEqual(resolved.virtualServer, vs);
            assert.strictEqual(resolved.appHandler, handler);
        });
        it('returns wildcard match for subdomain', () => {
            const roster = new Roster({ local: true });
            const vs = roster.createVirtualServer('*.example.com');
            const handler = () => {};
            const portData = {
                virtualServers: { '*.example.com': vs },
                appHandlers: { '*.example.com': handler }
            };
            const resolved = roster.getHandlerForPortData('api.example.com', portData);
            assert.ok(resolved);
            assert.strictEqual(resolved.virtualServer, vs);
            assert.strictEqual(resolved.appHandler, handler);
        });
        it('returns null when no match', () => {
            const roster = new Roster({ local: true });
            const portData = { virtualServers: {}, appHandlers: {} };
            assert.strictEqual(roster.getHandlerForPortData('unknown.com', portData), null);
        });
    });

    describe('getUrl (wildcard)', () => {
        it('returns URL for wildcard-matched host in local mode', () => {
            const roster = new Roster({ local: true });
            roster.register('*.example.com', () => {});
            roster.domainPorts = { '*.example.com': 9999 };
            roster.local = true;
            assert.strictEqual(roster.getUrl('api.example.com'), 'http://localhost:9999');
        });
        it('returns https URL for wildcard-matched host in production', () => {
            const roster = new Roster({ local: false });
            roster.register('*.example.com', () => {});
            roster.local = false;
            assert.strictEqual(roster.getUrl('api.example.com'), 'https://api.example.com');
        });
        it('returns null for host that matches no site', () => {
            const roster = new Roster({ local: true });
            assert.strictEqual(roster.getUrl('unknown.com'), null);
        });
    });

    describe('register validation', () => {
        it('throws when domain is missing', () => {
            const roster = new Roster({ local: true });
            assert.throws(() => roster.register('', () => {}), /Domain is required/);
            assert.throws(() => roster.register(null, () => {}), /Domain is required/);
        });
        it('throws when handler is not a function', () => {
            const roster = new Roster({ local: true });
            assert.throws(() => roster.register('*.example.com', {}), /requestHandler must be a function/);
        });
    });

    describe('constructor', () => {
        it('throws when port is 80 and not local', () => {
            assert.throws(() => new Roster({ port: 80, local: false }), /Port 80 is reserved/);
        });
        it('allows port 80 when local is true', () => {
            const roster = new Roster({ port: 80, local: true });
            assert.strictEqual(roster.defaultPort, 80);
        });
        it('sets defaultPort 443 when port not given', () => {
            const roster = new Roster({ local: true });
            assert.strictEqual(roster.defaultPort, 443);
        });
        it('uses acme-dns-01-cli by default (resolved to absolute path for Greenlock)', () => {
            const roster = new Roster({ local: false });
            assert.ok(roster.dnsChallenge);
            assert.strictEqual(typeof roster.dnsChallenge.module, 'string');
            assert.ok(require('path').isAbsolute(roster.dnsChallenge.module));
            assert.ok(roster.dnsChallenge.module.includes('acme-dns-01-cli-wrapper'));
            assert.strictEqual(roster.dnsChallenge.propagationDelay, 120000);
            assert.strictEqual(roster.dnsChallenge.autoContinue, false);
            assert.strictEqual(roster.dnsChallenge.dryRunDelay, 120000);
        });
        it('normalizes explicit acme-dns-01-cli module to wrapper and sets default propagationDelay', () => {
            const roster = new Roster({ local: false, dnsChallenge: { module: 'acme-dns-01-cli' } });
            assert.ok(require('path').isAbsolute(roster.dnsChallenge.module));
            assert.ok(roster.dnsChallenge.module.includes('acme-dns-01-cli-wrapper'));
            assert.strictEqual(roster.dnsChallenge.propagationDelay, 120000);
            assert.strictEqual(roster.dnsChallenge.autoContinue, false);
            assert.strictEqual(roster.dnsChallenge.dryRunDelay, 120000);
        });
        it('keeps explicit non-cli dnsChallenge module as-is', () => {
            const roster = new Roster({ local: false, dnsChallenge: { module: 'acme-dns-01-route53', token: 'x' } });
            assert.strictEqual(roster.dnsChallenge.module, 'acme-dns-01-route53');
            assert.strictEqual(roster.dnsChallenge.token, 'x');
            assert.strictEqual(roster.dnsChallenge.propagationDelay, 120000);
            assert.strictEqual(roster.dnsChallenge.autoContinue, false);
            assert.strictEqual(roster.dnsChallenge.dryRunDelay, 120000);
        });
        it('normalizes explicit acme-dns-01-cli absolute path to wrapper', () => {
            const path = require('path');
            const roster = new Roster({
                local: false,
                dnsChallenge: { module: path.join('/srv/roster/node_modules/acme-dns-01-cli', 'index.js') }
            });
            assert.ok(require('path').isAbsolute(roster.dnsChallenge.module));
            assert.ok(roster.dnsChallenge.module.includes('acme-dns-01-cli-wrapper'));
            assert.strictEqual(roster.dnsChallenge.propagationDelay, 120000);
            assert.strictEqual(roster.dnsChallenge.autoContinue, false);
            assert.strictEqual(roster.dnsChallenge.dryRunDelay, 120000);
        });
        it('allows disabling DNS challenge with dnsChallenge: false', () => {
            const roster = new Roster({ local: false, dnsChallenge: false });
            assert.strictEqual(roster.dnsChallenge, null);
        });
        it('enables disableWildcard from constructor option', () => {
            const roster = new Roster({ local: true, disableWildcard: true });
            assert.strictEqual(roster.disableWildcard, true);
        });
        it('reads disableWildcard from env var', () => {
            const previous = process.env.ROSTER_DISABLE_WILDCARD;
            process.env.ROSTER_DISABLE_WILDCARD = '1';
            try {
                const roster = new Roster({ local: true });
                assert.strictEqual(roster.disableWildcard, true);
            } finally {
                if (previous === undefined) delete process.env.ROSTER_DISABLE_WILDCARD;
                else process.env.ROSTER_DISABLE_WILDCARD = previous;
            }
        });
        it('enables combined wildcard certs from env var', () => {
            const previous = process.env.ROSTER_COMBINE_WILDCARD_CERTS;
            process.env.ROSTER_COMBINE_WILDCARD_CERTS = '1';
            try {
                const roster = new Roster({ local: false });
                assert.strictEqual(roster.combineWildcardCerts, true);
            } finally {
                if (previous === undefined) delete process.env.ROSTER_COMBINE_WILDCARD_CERTS;
                else process.env.ROSTER_COMBINE_WILDCARD_CERTS = previous;
            }
        });
        it('defaults combineWildcardCerts to false', () => {
            const roster = new Roster({ local: false });
            assert.strictEqual(roster.combineWildcardCerts, false);
        });
        it('explicit combineWildcardCerts=true enables combined cert mode', () => {
            const roster = new Roster({ local: false, combineWildcardCerts: true });
            assert.strictEqual(roster.combineWildcardCerts, true);
        });
    });

    describe('register (normal domain)', () => {
        it('adds domain and www when domain has fewer than 2 dots', () => {
            const roster = new Roster({ local: true });
            const handler = () => {};
            roster.register('example.com', handler);
            assert.strictEqual(roster.sites['example.com'], handler);
            assert.strictEqual(roster.sites['www.example.com'], handler);
        });
        it('does not add www for multi-label domain', () => {
            const roster = new Roster({ local: true });
            const handler = () => {};
            roster.register('api.example.com', handler);
            assert.strictEqual(roster.sites['api.example.com'], handler);
            assert.strictEqual(roster.sites['www.api.example.com'], undefined);
        });
    });

    describe('getUrl (exact domain)', () => {
        it('returns http://localhost:PORT in local mode for registered domain', () => {
            const roster = new Roster({ local: true });
            roster.register('exact.local', () => {});
            roster.domainPorts = { 'exact.local': 4567 };
            roster.local = true;
            assert.strictEqual(roster.getUrl('exact.local'), 'http://localhost:4567');
        });
        it('returns https URL in production for registered domain', () => {
            const roster = new Roster({ local: false });
            roster.register('example.com', () => {});
            roster.local = false;
            assert.strictEqual(roster.getUrl('example.com'), 'https://example.com');
        });
        it('strips www and returns canonical URL (same as non-www)', () => {
            const roster = new Roster({ local: false });
            roster.register('example.com', () => {});
            assert.strictEqual(roster.getUrl('www.example.com'), 'https://example.com');
            assert.strictEqual(roster.getUrl('example.com'), 'https://example.com');
        });
    });

    describe('handleRequest', () => {
        it('redirects www to non-www with 301', () => {
            const roster = new Roster({ local: true });
            const res = {
                writeHead: (status, headers) => {
                    assert.strictEqual(status, 301);
                    assert.strictEqual(headers.Location, 'https://example.com/');
                },
                end: () => {}
            };
            roster.handleRequest(
                { headers: { host: 'www.example.com' }, url: '/' },
                res
            );
        });
        it('returns 404 when host has no handler', () => {
            const roster = new Roster({ local: true });
            let status;
            const res = {
                writeHead: (s) => { status = s; },
                end: () => {}
            };
            roster.handleRequest(
                { headers: { host: 'unknown.example.com' }, url: '/' },
                res
            );
            assert.strictEqual(status, 404);
        });
        it('invokes handler for registered host', () => {
            const roster = new Roster({ local: true });
            let called = false;
            roster.register('example.com', (req, res) => {
                called = true;
                res.writeHead(200);
                res.end('ok');
            });
            const res = {
                writeHead: () => {},
                end: () => {}
            };
            roster.handleRequest(
                { headers: { host: 'example.com' }, url: '/' },
                res
            );
            assert.strictEqual(called, true);
        });
    });
});

describe('Roster local mode (local: true)', () => {
    it('starts HTTP server and responds for registered domain', async () => {
        const roster = new Roster({
            local: true,
            minLocalPort: 19090,
            maxLocalPort: 19099,
            hostname: 'localhost'
        });
        const body = 'local-mode-ok';
        roster.register('testlocal.example', (server) => {
            return (req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(body);
            };
        });
        await roster.start();
        try {
            const port = roster.domainPorts['testlocal.example'];
            assert.ok(typeof port === 'number' && port >= 19090 && port <= 19099);
            await new Promise((r) => setTimeout(r, 50));
            const result = await httpGet('localhost', port, '/');
            assert.strictEqual(result.statusCode, 200);
            assert.strictEqual(result.body, body);
        } finally {
            closePortServers(roster);
        }
    });

    it('getUrl returns localhost URL after start', async () => {
        const roster = new Roster({
            local: true,
            minLocalPort: 19100,
            maxLocalPort: 19109
        });
        roster.register('geturltest.example', () => () => {});
        await roster.start();
        try {
            const url = roster.getUrl('geturltest.example');
            assert.ok(url && url.startsWith('http://localhost:'));
            assert.ok(roster.domainPorts['geturltest.example'] !== undefined);
        } finally {
            closePortServers(roster);
        }
    });
});

describe('Roster loadSites', () => {
    it('loads site from www directory and registers domain + www', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'));
        const wwwPath = path.join(tmpDir, 'www');
        const siteDir = path.join(wwwPath, 'loaded.example');
        fs.mkdirSync(siteDir, { recursive: true });
        fs.writeFileSync(
            path.join(siteDir, 'index.js'),
            'module.exports = () => (req, res) => { res.writeHead(200); res.end("loaded"); };',
            'utf8'
        );
        try {
            const roster = new Roster({ wwwPath, local: true });
            await roster.loadSites();
            assert.ok(roster.sites['loaded.example']);
            assert.ok(roster.sites['www.loaded.example']);
            const handler = roster.sites['loaded.example'];
            assert.strictEqual(typeof handler, 'function');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('loads wildcard site from www/*.example.com directory', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'));
        const wwwPath = path.join(tmpDir, 'www');
        const siteDir = path.join(wwwPath, '*.wildcard.example');
        fs.mkdirSync(siteDir, { recursive: true });
        fs.writeFileSync(
            path.join(siteDir, 'index.js'),
            'module.exports = () => (req, res) => { res.writeHead(200); res.end("wildcard"); };',
            'utf8'
        );
        try {
            const roster = new Roster({ wwwPath, local: true });
            await roster.loadSites();
            assert.ok(roster.sites['*.wildcard.example']);
            assert.ok(roster.wildcardZones.has('wildcard.example'));
            assert.strictEqual(roster.getHandlerForHost('api.wildcard.example'), roster.sites['*.wildcard.example']);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('skips wildcard site from www when disableWildcard is true', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'));
        const wwwPath = path.join(tmpDir, 'www');
        const siteDir = path.join(wwwPath, '*.wildcard.example');
        fs.mkdirSync(siteDir, { recursive: true });
        fs.writeFileSync(
            path.join(siteDir, 'index.js'),
            'module.exports = () => (req, res) => { res.writeHead(200); res.end("wildcard"); };',
            'utf8'
        );
        try {
            const roster = new Roster({ wwwPath, local: true, disableWildcard: true });
            await roster.loadSites();
            assert.strictEqual(roster.sites['*.wildcard.example'], undefined);
            assert.strictEqual(roster.wildcardZones.has('wildcard.example'), false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does not throw when www path does not exist', async () => {
        const roster = new Roster({
            wwwPath: path.join(os.tmpdir(), 'roster-nonexistent-' + Date.now()),
            local: true
        });
        await assert.doesNotReject(roster.loadSites());
    });

    it('loads static site from www/domain when index.html exists and no index.js', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'));
        const wwwPath = path.join(tmpDir, 'www');
        const siteDir = path.join(wwwPath, 'static.example');
        fs.mkdirSync(siteDir, { recursive: true });
        fs.writeFileSync(path.join(siteDir, 'index.html'), '<html>hello</html>', 'utf8');
        try {
            const roster = new Roster({ wwwPath, local: true });
            await roster.loadSites();
            assert.ok(roster.sites['static.example']);
            assert.ok(roster.sites['www.static.example']);
            const handler = roster.sites['static.example'];
            assert.strictEqual(typeof handler, 'function');
            const appHandler = handler(roster.createVirtualServer('static.example'));
            assert.strictEqual(typeof appHandler, 'function');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('loads index.js over index.html when both exist', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'));
        const wwwPath = path.join(tmpDir, 'www');
        const siteDir = path.join(wwwPath, 'both.example');
        fs.mkdirSync(siteDir, { recursive: true });
        fs.writeFileSync(path.join(siteDir, 'index.html'), '<html>static</html>', 'utf8');
        fs.writeFileSync(
            path.join(siteDir, 'index.js'),
            'module.exports = () => (req, res) => { res.writeHead(200); res.end("js"); };',
            'utf8'
        );
        try {
            const roster = new Roster({ wwwPath, local: true });
            await roster.loadSites();
            const handler = roster.sites['both.example'];
            const appHandler = handler(roster.createVirtualServer('both.example'));
            let body = '';
            const res = { writeHead: () => {}, end: (b) => { body = (b || '').toString(); } };
            appHandler({ url: '/', method: 'GET' }, res);
            assert.strictEqual(body, 'js');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('static site serves index.html for / in local mode', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'));
        const wwwPath = path.join(tmpDir, 'www');
        const siteDir = path.join(wwwPath, 'staticlocal.example');
        fs.mkdirSync(siteDir, { recursive: true });
        const html = '<html><body>static ok</body></html>';
        fs.writeFileSync(path.join(siteDir, 'index.html'), html, 'utf8');
        const roster = new Roster({ wwwPath, local: true, minLocalPort: 19200, maxLocalPort: 19209 });
        try {
            await roster.start();
            const port = roster.domainPorts['staticlocal.example'];
            assert.ok(typeof port === 'number');
            await new Promise((r) => setTimeout(r, 50));
            const result = await httpGet('localhost', port, '/');
            assert.strictEqual(result.statusCode, 200);
            assert.ok(result.body.includes('static ok'));
        } finally {
            closePortServers(roster);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('static site returns 404 for non-existent path', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'));
        const wwwPath = path.join(tmpDir, 'www');
        const siteDir = path.join(wwwPath, 'static404.example');
        fs.mkdirSync(siteDir, { recursive: true });
        fs.writeFileSync(path.join(siteDir, 'index.html'), '<html>ok</html>', 'utf8');
        const roster = new Roster({ wwwPath, local: true, minLocalPort: 19210, maxLocalPort: 19219 });
        try {
            await roster.start();
            const port = roster.domainPorts['static404.example'];
            assert.ok(typeof port === 'number');
            await new Promise((r) => setTimeout(r, 50));
            const result = await httpGet('localhost', port, '/nonexistent.html');
            assert.strictEqual(result.statusCode, 404);
        } finally {
            closePortServers(roster);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Roster generateConfigJson', () => {
    it('uses http-01 for apex/www and dns-01 only for wildcard cert', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-config-'));
        try {
            const roster = new Roster({
                local: false,
                greenlockStorePath: tmpDir,
                dnsChallenge: {
                    module: 'acme-dns-01-cli',
                    propagationDelay: 120000,
                    autoContinue: false,
                    dryRunDelay: 120000
                }
            });

            roster.domains = ['tagnu.com', 'www.tagnu.com', '*.tagnu.com'];
            roster.wildcardZones.add('tagnu.com');
            roster.generateConfigJson();

            const configPath = path.join(tmpDir, 'config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const apexSite = config.sites.find((site) => site.subject === 'tagnu.com');
            const wildcardSite = config.sites.find((site) => site.subject === '*.tagnu.com');

            assert.ok(apexSite);
            assert.deepStrictEqual(apexSite.altnames.sort(), ['tagnu.com', 'www.tagnu.com'].sort());
            assert.strictEqual(apexSite.challenges, undefined);

            assert.ok(wildcardSite);
            assert.deepStrictEqual(wildcardSite.altnames, ['*.tagnu.com']);
            assert.ok(wildcardSite.challenges && wildcardSite.challenges['dns-01']);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('can combine apex+www+wildcard in one cert with dns-01', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-config-'));
        try {
            const roster = new Roster({
                local: false,
                greenlockStorePath: tmpDir,
                combineWildcardCerts: true,
                dnsChallenge: {
                    module: 'acme-dns-01-cli',
                    propagationDelay: 120000,
                    autoContinue: false,
                    dryRunDelay: 120000
                }
            });
            roster.domains = ['tagnu.com', 'www.tagnu.com', '*.tagnu.com'];
            roster.wildcardZones.add('tagnu.com');
            roster.generateConfigJson();

            const configPath = path.join(tmpDir, 'config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const apexSite = config.sites.find((site) => site.subject === 'tagnu.com');
            const wildcardSite = config.sites.find((site) => site.subject === '*.tagnu.com');

            assert.ok(apexSite);
            assert.deepStrictEqual(
                apexSite.altnames.sort(),
                ['tagnu.com', 'www.tagnu.com', '*.tagnu.com'].sort()
            );
            assert.ok(apexSite.challenges && apexSite.challenges['dns-01']);
            assert.strictEqual(wildcardSite, undefined);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
