'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const wrapper = require('../vendor/acme-dns-01-cli-wrapper.js');

function buildChallengeOpts() {
    return {
        challenge: {
            altname: '*.example.com',
            dnsHost: '_acme-challenge.example.com',
            dnsAuthorization: 'test-token'
        }
    };
}

describe('acme-dns-01-cli-wrapper automatic Linode DNS', () => {
    const originalFetch = global.fetch;
    const originalLinodeApiKey = process.env.LINODE_API_KEY;

    afterEach(() => {
        global.fetch = originalFetch;
        if (originalLinodeApiKey === undefined) delete process.env.LINODE_API_KEY;
        else process.env.LINODE_API_KEY = originalLinodeApiKey;
    });

    it('creates and removes TXT records via Linode API', async () => {
        const calls = [];
        global.fetch = async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/domains?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [{ id: 42, domain: 'example.com' }] }) };
            }
            if (url.endsWith('/domains/42/records?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [] }) };
            }
            if (url.endsWith('/domains/42/records') && options.method === 'POST') {
                return { ok: true, status: 200, json: async () => ({ id: 321 }) };
            }
            if (url.endsWith('/domains/42/records/321') && options.method === 'DELETE') {
                return { ok: true, status: 204, json: async () => ({}) };
            }
            return { ok: false, status: 404, statusText: 'not mocked', text: async () => 'not mocked' };
        };

        const challenger = wrapper.create({
            provider: 'linode',
            linodeApiKey: 'fake-token',
            verifyDnsBeforeContinue: false,
            propagationDelay: 0,
            dryRunDelay: 0
        });

        const opts = buildChallengeOpts();
        await challenger.set(opts);
        await challenger.remove(opts);

        assert.ok(calls.some((c) => c.url.endsWith('/domains/42/records') && c.options.method === 'POST'));
        assert.ok(calls.some((c) => c.url.endsWith('/domains/42/records/321') && c.options.method === 'DELETE'));
    });

    it('uses LINODE_API_KEY from environment', async () => {
        process.env.LINODE_API_KEY = 'fake-linode-key';
        const calls = [];
        global.fetch = async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/domains?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [{ id: 42, domain: 'example.com' }] }) };
            }
            if (url.endsWith('/domains/42/records?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [{ id: 111, type: 'TXT', name: '_acme-challenge', target: 'test-token' }] }) };
            }
            return { ok: true, status: 204, json: async () => ({}) };
        };

        const challenger = wrapper.create({
            provider: 'linode',
            verifyDnsBeforeContinue: false,
            propagationDelay: 0,
            dryRunDelay: 0
        });

        await challenger.set(buildChallengeOpts());
        assert.ok(calls.length >= 2);
        const authHeader = calls[0].options?.headers?.Authorization || '';
        assert.ok(authHeader.startsWith('Bearer '));
    });

    it('falls back to parent zone when exact zone does not exist', async () => {
        const calls = [];
        global.fetch = async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/domains?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [{ id: 99, domain: 'example.com' }] }) };
            }
            if (url.endsWith('/domains/99/records?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [] }) };
            }
            if (url.endsWith('/domains/99/records') && options.method === 'POST') {
                return { ok: true, status: 200, json: async () => ({ id: 654 }) };
            }
            if (url.endsWith('/domains/99/records/654') && options.method === 'DELETE') {
                return { ok: true, status: 204, json: async () => ({}) };
            }
            return { ok: false, status: 404, statusText: 'not mocked', text: async () => 'not mocked' };
        };

        const challenger = wrapper.create({
            provider: 'linode',
            linodeApiKey: 'fake-token',
            verifyDnsBeforeContinue: false,
            propagationDelay: 0,
            dryRunDelay: 0
        });

        const opts = {
            challenge: {
                altname: '*.sub.example.com',
                dnsHost: '_acme-challenge.sub.example.com',
                dnsAuthorization: 'fallback-token'
            }
        };

        await challenger.set(opts);
        await challenger.remove(opts);

        const postCall = calls.find((c) => c.url.endsWith('/domains/99/records') && c.options.method === 'POST');
        assert.ok(postCall, 'expected TXT create call on parent zone');
        const payload = JSON.parse(postCall.options.body);
        assert.strictEqual(payload.name, '_acme-challenge.sub');
    });

    it('prefers apex zone over www zone for www challenges', async () => {
        const calls = [];
        global.fetch = async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/domains?page_size=500')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        data: [
                            { id: 777, domain: 'www.tagnu.com' },
                            { id: 888, domain: 'tagnu.com' }
                        ]
                    })
                };
            }
            if (url.endsWith('/domains/888/records?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [] }) };
            }
            if (url.endsWith('/domains/888/records') && options.method === 'POST') {
                return { ok: true, status: 200, json: async () => ({ id: 333 }) };
            }
            return { ok: true, status: 204, json: async () => ({}) };
        };

        const challenger = wrapper.create({
            provider: 'linode',
            linodeApiKey: 'fake-token',
            verifyDnsBeforeContinue: false,
            propagationDelay: 0,
            dryRunDelay: 0
        });

        await challenger.set({
            challenge: {
                altname: 'www.tagnu.com',
                dnsHost: '_greenlock-dryrun-abc.www.tagnu.com',
                dnsAuthorization: 'www-token'
            }
        });

        assert.ok(calls.some((c) => c.url.endsWith('/domains/888/records') && c.options.method === 'POST'));
        assert.ok(!calls.some((c) => c.url.endsWith('/domains/777/records') && c.options.method === 'POST'));
    });

    it('falls back to manual when provider mode has no API key (default)', async () => {
        const prevLinode = process.env.LINODE_API_KEY;
        delete process.env.LINODE_API_KEY;
        global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

        try {
            const challenger = wrapper.create({
                provider: 'linode',
                verifyDnsBeforeContinue: false,
                propagationDelay: 0,
                dryRunDelay: 0
            });
            await challenger.set(buildChallengeOpts());
        } finally {
            if (prevLinode === undefined) delete process.env.LINODE_API_KEY;
            else process.env.LINODE_API_KEY = prevLinode;
        }
    });

    it('throws when provider mode has no API key and strict mode is enabled', async () => {
        const prevLinode = process.env.LINODE_API_KEY;
        delete process.env.LINODE_API_KEY;
        global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

        try {
            const challenger = wrapper.create({
                provider: 'linode',
                dnsApiFallbackToManual: false,
                verifyDnsBeforeContinue: false,
                propagationDelay: 0,
                dryRunDelay: 0
            });
            await assert.rejects(
                challenger.set(buildChallengeOpts()),
                /Linode API key not configured/
            );
        } finally {
            if (prevLinode === undefined) delete process.env.LINODE_API_KEY;
            else process.env.LINODE_API_KEY = prevLinode;
        }
    });

    it('uses configured TXT TTL when creating Linode records', async () => {
        const calls = [];
        global.fetch = async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/domains?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [{ id: 42, domain: 'example.com' }] }) };
            }
            if (url.endsWith('/domains/42/records?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [] }) };
            }
            if (url.endsWith('/domains/42/records') && options.method === 'POST') {
                return { ok: true, status: 200, json: async () => ({ id: 222 }) };
            }
            return { ok: true, status: 204, json: async () => ({}) };
        };

        const challenger = wrapper.create({
            provider: 'linode',
            linodeApiKey: 'fake-token',
            txtRecordTtl: 300,
            verifyDnsBeforeContinue: false,
            propagationDelay: 0,
            dryRunDelay: 0
        });

        await challenger.set(buildChallengeOpts());
        const postCall = calls.find((c) => c.url.endsWith('/domains/42/records') && c.options.method === 'POST');
        assert.ok(postCall, 'expected TXT create call');
        const payload = JSON.parse(postCall.options.body);
        assert.strictEqual(payload.ttl_sec, 300);
    });

    it('auto-enables Linode provider when API key is present', async () => {
        process.env.LINODE_API_KEY = 'fake-token';
        const calls = [];
        global.fetch = async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/domains?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [{ id: 42, domain: 'example.com' }] }) };
            }
            if (url.endsWith('/domains/42/records?page_size=500')) {
                return { ok: true, status: 200, json: async () => ({ data: [{ id: 111, type: 'TXT', name: '_acme-challenge', target: 'test-token' }] }) };
            }
            return { ok: true, status: 204, json: async () => ({}) };
        };

        const challenger = wrapper.create({
            verifyDnsBeforeContinue: false,
            propagationDelay: 0,
            dryRunDelay: 0
        });

        await challenger.set(buildChallengeOpts());
        assert.ok(calls.length >= 2);
    });

    it('falls back to manual flow when Linode API fails', async () => {
        let fetchCalls = 0;
        global.fetch = async () => {
            fetchCalls += 1;
            return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'not found' };
        };

        const challenger = wrapper.create({
            provider: 'linode',
            linodeApiKey: 'fake-token',
            dnsApiFallbackToManual: true,
            verifyDnsBeforeContinue: false,
            propagationDelay: 0,
            dryRunDelay: 0
        });

        await challenger.set(buildChallengeOpts());
        assert.ok(fetchCalls > 0);
    });
});
