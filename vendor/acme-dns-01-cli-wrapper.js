'use strict';

const legacyCli = require('acme-dns-01-cli');
const log = require('lemonlog')('acme-dns-01');
const dns = require('node:dns').promises;
const { execFileSync } = require('node:child_process');
let envFileLoadAttempted = false;

function loadEnvFileSafely() {
    if (envFileLoadAttempted) return;
    envFileLoadAttempted = true;
    try {
        if (typeof process.loadEnvFile === 'function') {
            process.loadEnvFile();
        }
    } catch {
        // Ignore missing .env or unsupported runtime behavior.
    }
}

function toPromise(fn, context) {
    if (typeof fn !== 'function') {
        return async function () {
            return null;
        };
    }

    return async function (opts) {
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (err, result) => {
                if (done) return;
                done = true;
                if (err) reject(err);
                else resolve(result);
            };

            try {
                // Legacy callback style
                if (fn.length >= 2) {
                    fn.call(context, opts, finish);
                    return;
                }

                // Promise or sync style
                Promise.resolve(fn.call(context, opts)).then(
                    (result) => finish(null, result),
                    finish
                );
            } catch (err) {
                finish(err);
            }
        });
    };
}

module.exports.create = function create(config = {}) {
    loadEnvFileSafely();
    const challenger = legacyCli.create(config);
    const propagationDelay = Number.isFinite(config.propagationDelay)
        ? config.propagationDelay
        : 120000;
    const envAutoContinue = process.env.ROSTER_DNS_AUTO_CONTINUE;
    const parseAutoContinue = (value, fallback) => {
        if (value === undefined || value === null || value === '') return fallback;
        const normalized = String(value).trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        return fallback;
    };
    const autoContinue = config.autoContinue !== undefined
        ? parseAutoContinue(config.autoContinue, false)
        : parseAutoContinue(envAutoContinue, false);
    const dryRunDelay = Number.isFinite(config.dryRunDelay)
        ? config.dryRunDelay
        : Number.isFinite(Number(process.env.ROSTER_DNS_DRYRUN_DELAY_MS))
            ? Number(process.env.ROSTER_DNS_DRYRUN_DELAY_MS)
            : propagationDelay;
    const parseBool = (value, fallback) => {
        if (value === undefined || value === null || value === '') return fallback;
        const normalized = String(value).trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        return fallback;
    };
    const verifyDnsBeforeContinue = config.verifyDnsBeforeContinue !== undefined
        ? parseBool(config.verifyDnsBeforeContinue, true)
        : parseBool(process.env.ROSTER_DNS_VERIFY_BEFORE_CONTINUE, true);
    const dnsPollIntervalMs = Number.isFinite(config.dnsPollIntervalMs)
        ? config.dnsPollIntervalMs
        : Number.isFinite(Number(process.env.ROSTER_DNS_POLL_INTERVAL_MS))
            ? Number(process.env.ROSTER_DNS_POLL_INTERVAL_MS)
            : 15000;
    const parseTimeoutMs = (value, fallback) => {
        if (value === undefined || value === null || value === '') return fallback;
        const normalized = String(value).trim().toLowerCase();
        if (normalized === '-1' || normalized === 'inf' || normalized === 'infinite') return null;
        const parsed = Number(normalized);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
        return fallback;
    };
    const dnsPollTimeoutMs = config.dnsPollTimeoutMs !== undefined
        ? parseTimeoutMs(config.dnsPollTimeoutMs, propagationDelay)
        : parseTimeoutMs(process.env.ROSTER_DNS_POLL_TIMEOUT_MS, propagationDelay * 2);
    const dryRunPollTimeoutMs = config.dryRunPollTimeoutMs !== undefined
        ? parseTimeoutMs(config.dryRunPollTimeoutMs, dryRunDelay)
        : parseTimeoutMs(process.env.ROSTER_DNS_DRYRUN_POLL_TIMEOUT_MS, dryRunDelay * 2);
    const dnsPollDebug = config.dnsPollDebug !== undefined
        ? parseBool(config.dnsPollDebug, true)
        : parseBool(process.env.ROSTER_DNS_POLL_DEBUG, true);
    const parseResolvers = (value) => String(value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const configuredResolvers = Array.isArray(config.dnsResolvers)
        ? config.dnsResolvers.map((s) => String(s).trim()).filter(Boolean)
        : parseResolvers(process.env.ROSTER_DNS_RESOLVERS);
    const effectiveResolvers = configuredResolvers.length > 0 ? configuredResolvers : ['1.1.1.1', '8.8.8.8'];
    const staticResolverClients = effectiveResolvers.map((server) => {
        const resolver = new dns.Resolver();
        resolver.setServers([server]);
        return { server, resolver };
    });
    const normalizeProvider = (value) => String(value || '').trim().toLowerCase();
    const configuredProvider = normalizeProvider(
        config.provider
        || process.env.ROSTER_DNS_PROVIDER
        || (config.linodeApiKey || process.env.LINODE_API_KEY ? 'linode' : '')
    );
    const isLinodeProvider = configuredProvider === 'linode';
    const dnsApiFallbackToManual = config.dnsApiFallbackToManual !== undefined
        ? parseBool(config.dnsApiFallbackToManual, true)
        : parseBool(process.env.ROSTER_DNS_API_FALLBACK_TO_MANUAL, true);
    const linodeApiKey = config.linodeApiKey
        || process.env.LINODE_API_KEY
        || '';
    const linodeApiBase = String(config.linodeApiBase || process.env.LINODE_API_BASE_URL || 'https://api.linode.com/v4').replace(/\/+$/, '');
    const txtRecordTtl = Number.isFinite(config.txtRecordTtl) ? Math.max(30, Number(config.txtRecordTtl)) : 60;

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function normalizeTxtChunk(value) {
        return String(value || '').replace(/^"+|"+$/g, '');
    }

    function resolveExpectedToken(opts, ch) {
        const candidate = ch?.dnsAuthorization || opts?.dnsAuthorization;
        return candidate ? String(candidate).trim() : '';
    }

    async function resolveTxtRecords(dnsHost) {
        const records = [];
        const errors = [];
        const resolverClients = staticResolverClients;
        const seenServers = new Set();

        for (const { server, resolver } of resolverClients) {
            if (seenServers.has(server)) continue;
            seenServers.add(server);

            // Primary path: query with dig directly (more reliable under Bun).
            const serverTarget = String(server || '');
            let digAttempted = false;
            if (typeof execFileSync === 'function' && serverTarget) {
                digAttempted = true;
                try {
                    const output = execFileSync('dig', ['+short', 'TXT', dnsHost, `@${serverTarget}`], {
                        encoding: 'utf8',
                        stdio: ['ignore', 'pipe', 'ignore'],
                        timeout: 4000
                    });
                    const lines = String(output || '')
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean);
                    if (lines.length > 0) {
                        for (const line of lines) {
                            const normalized = normalizeTxtChunk(line);
                            if (normalized) records.push([normalized]);
                        }
                    } else {
                        errors.push(`${server}:ENOTFOUND`);
                    }
                    continue;
                } catch (error) {
                    errors.push(`${server}:DIG_${error?.code || error?.signal || 'ERROR'}`);
                }
            }

            // Fallback path only if dig is unavailable/failed unexpectedly.
            if ((!digAttempted || records.length === 0) && resolver) {
                try {
                    const result = await resolver.resolveTxt(dnsHost);
                    if (Array.isArray(result)) {
                        records.push(...result);
                    }
                } catch (error) {
                    errors.push(`${server}:${error?.code || error?.message || error}`);
                }
            }
        }
        return { records, errors };
    }

    async function waitForDnsTxtPropagation(dnsHost, expectedToken, timeoutMs) {
        const started = Date.now();
        const hasFiniteTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0;
        const maxWait = hasFiniteTimeout ? timeoutMs : null;
        let attempt = 0;
        while (maxWait === null || (Date.now() - started) <= maxWait) {
            attempt += 1;
            const { records, errors } = await resolveTxtRecords(dnsHost);
            const seenTokens = [];
            let found = false;
            for (const recordParts of records || []) {
                const joined = (recordParts || []).map(normalizeTxtChunk).join('').trim();
                if (joined) seenTokens.push(joined);
                if (joined === expectedToken) {
                    found = true;
                }
            }

            if (dnsPollDebug) {
                const errorMsg = errors.length > 0 ? ` errors=[${errors.join(', ')}]` : '';
                const seenMsg = seenTokens.length > 0 ? ` seen=[${seenTokens.join(', ')}]` : ' seen=[]';
                log.info(`DNS poll attempt ${attempt} ${dnsHost}${seenMsg}${errorMsg}`);
            }

            if (found) return true;
            await sleep(Math.max(1000, dnsPollIntervalMs));
        }
        return false;
    }

    const presentedByHost = new Map();
    const presentedByAltname = new Map();
    const linodeTxtRecordsByHost = new Map();
    const linodeZoneCache = new Map();

    function buildZoneCandidates({ dnsHost, altname }) {
        const candidates = new Set();
        const add = (value) => {
            const normalized = String(value || '').replace(/\.$/, '').toLowerCase();
            if (!normalized) return;
            const labels = normalized.split('.').filter(Boolean);
            for (let i = 0; i <= labels.length - 2; i += 1) {
                candidates.add(labels.slice(i).join('.'));
            }
        };

        // Prefer apex zone when validating www.<domain> challenges so records are
        // created in the commonly delegated parent zone (e.g. tagnu.com).
        if (altname) {
            const normalizedAltname = String(altname).replace(/^\*\./, '').replace(/\.$/, '').toLowerCase();
            if (normalizedAltname.startsWith('www.')) {
                add(normalizedAltname.slice(4));
            }
        }
        if (dnsHost) {
            const normalizedDnsHost = String(dnsHost).replace(/^_acme-challenge\./, '').replace(/^_greenlock-[^.]+\./, '');
            add(normalizedDnsHost);
        }
        if (altname) {
            add(String(altname).replace(/^\*\./, ''));
        }
        return Array.from(candidates);
    }

    function linodeRecordNameForHost(dnsHost, zone) {
        const host = String(dnsHost || '').replace(/\.$/, '').toLowerCase();
        const normalizedZone = String(zone || '').replace(/\.$/, '').toLowerCase();
        if (!host || !normalizedZone) return '';
        if (host === normalizedZone) return '';
        if (!host.endsWith(`.${normalizedZone}`)) return '';
        return host.slice(0, host.length - normalizedZone.length - 1);
    }

    async function linodeRequest(pathname, method = 'GET', body) {
        const apiKey = String(linodeApiKey || '').trim();
        if (!apiKey) {
            throw new Error('Linode API key not configured. Set LINODE_API_KEY.');
        }
        if (typeof fetch !== 'function') {
            throw new Error('Global fetch is unavailable in this runtime; cannot call Linode DNS API.');
        }
        const response = await fetch(`${linodeApiBase}${pathname}`, {
            method,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            ...(body ? { body: JSON.stringify(body) } : {})
        });

        if (!response.ok) {
            let details = '';
            try {
                details = await response.text();
            } catch {
                details = '';
            }
            throw new Error(`Linode API ${method} ${pathname} failed (${response.status}): ${details || response.statusText}`);
        }
        if (response.status === 204) return null;
        return response.json();
    }

    async function resolveLinodeZone(zone) {
        const normalizedZone = String(zone || '').trim().toLowerCase();
        if (!normalizedZone) return null;
        if (linodeZoneCache.has(normalizedZone)) return linodeZoneCache.get(normalizedZone);

        const domainsResult = await linodeRequest('/domains?page_size=500', 'GET');
        const domains = Array.isArray(domainsResult?.data) ? domainsResult.data : [];
        const matched = domains.find((entry) => String(entry?.domain || '').trim().toLowerCase() === normalizedZone);
        if (!matched?.id) return null;

        const zoneInfo = { id: matched.id, domain: String(matched.domain || normalizedZone) };
        linodeZoneCache.set(normalizedZone, zoneInfo);
        return zoneInfo;
    }

    async function linodeUpsertTxtRecord(dnsHost, dnsAuthorization, altname) {
        const zoneCandidates = buildZoneCandidates({ dnsHost, altname });
        let lastError = null;

        for (const zone of zoneCandidates) {
            let zoneInfo = null;
            try {
                zoneInfo = await resolveLinodeZone(zone);
            } catch (error) {
                lastError = error;
                continue;
            }
            if (!zoneInfo?.id) continue;

            const recordName = linodeRecordNameForHost(dnsHost, zone);
            if (!recordName && dnsHost !== zone) continue;

            const zoneId = zoneInfo.id;
            const recordsResult = await linodeRequest(`/domains/${zoneId}/records?page_size=500`, 'GET');
            const existing = Array.isArray(recordsResult?.data) ? recordsResult.data : [];
            const sameRecord = existing.find((record) =>
                record?.type === 'TXT'
                && String(record?.name || '') === String(recordName || '')
                && String(record?.target || '') === String(dnsAuthorization || '')
            );

            if (sameRecord && sameRecord.id) {
                linodeTxtRecordsByHost.set(dnsHost, { zone, zoneId, id: sameRecord.id });
                return { zone, zoneId, id: sameRecord.id, reused: true };
            }

            const created = await linodeRequest(`/domains/${zoneId}/records`, 'POST', {
                type: 'TXT',
                name: recordName,
                target: dnsAuthorization,
                ttl_sec: txtRecordTtl
            });

            if (created?.id) {
                linodeTxtRecordsByHost.set(dnsHost, { zone, zoneId, id: created.id });
                return { zone, zoneId, id: created.id, reused: false };
            }
        }

        if (lastError) throw lastError;
        throw new Error(`Unable to map ${dnsHost} to a Linode DNS zone`);
    }

    async function linodeRemoveTxtRecord(dnsHost) {
        const stored = linodeTxtRecordsByHost.get(dnsHost);
        if (!stored?.zoneId || !stored?.id) return false;
        await linodeRequest(`/domains/${stored.zoneId}/records/${stored.id}`, 'DELETE');
        linodeTxtRecordsByHost.delete(dnsHost);
        return true;
    }

    async function setChallenge(opts) {
        const ch = opts?.challenge || {};
        const altname = ch.altname || opts?.altname || 'unknown';
        const dnsHost = String(ch.dnsHost || '');
        const dnsAuth = ch.dnsAuthorization || opts?.dnsAuthorization || null;
        const token = ch.dnsAuthorization || '<dns-authorization-token>';
        const host = ch.dnsHost || '_acme-challenge.<domain>';

        if (dnsHost && dnsAuth) {
            presentedByHost.set(dnsHost, dnsAuth);
        }
        if (altname && dnsAuth) {
            presentedByAltname.set(altname, { dnsHost, dnsAuthorization: dnsAuth });
        }
        if (isLinodeProvider && dnsHost && dnsAuth) {
            try {
                const result = await linodeUpsertTxtRecord(dnsHost, dnsAuth, altname);
                log.info(
                    `Linode DNS TXT ${result?.reused ? 'reused' : 'created'} for ${dnsHost}` +
                    (result?.zone ? ` (zone ${result.zone})` : '')
                );
            } catch (error) {
                const errorMsg = error?.message || error;
                if (dnsApiFallbackToManual) {
                    log.warn(
                        `Linode DNS API failed for ${dnsHost}: ${errorMsg}. ` +
                        'Falling back to manual/legacy DNS flow for this challenge.'
                    );
                } else {
                    log.error(`Failed to create Linode DNS TXT for ${dnsHost}: ${errorMsg}`);
                    throw error;
                }
            }
        }
        const isDryRunChallenge = dnsHost.includes('_greenlock-dryrun-');
        const effectiveDelay = isDryRunChallenge
            ? Math.max(0, dryRunDelay)
            : propagationDelay;
        const effectiveTimeoutMs = isDryRunChallenge
            ? dryRunPollTimeoutMs
            : (dnsPollTimeoutMs === null ? effectiveDelay : dnsPollTimeoutMs);
        const expectedToken = resolveExpectedToken(opts, ch);

        log.info('DNS-01 ' + altname);
        log.info('TXT ' + host + '  ' + token + '  (TTL 60)');
        if (verifyDnsBeforeContinue && dnsHost && expectedToken) {
            log.info(
                'DNS verification enabled. Continuing automatically when TXT appears at ' +
                dnsHost +
                ' (timeout ' +
                (effectiveTimeoutMs === null ? 'infinite' : (effectiveTimeoutMs + 'ms')) +
                ', poll ' +
                dnsPollIntervalMs +
                'ms).'
            );
            const propagated = await waitForDnsTxtPropagation(dnsHost, expectedToken, effectiveTimeoutMs);
            if (propagated) {
                log.info(`DNS TXT detected for ${dnsHost}; continuing ACME flow.`);
                return null;
            }
            log.warn(
                `DNS TXT not detected for ${dnsHost} within ${effectiveTimeoutMs === null ? 'infinite' : (effectiveTimeoutMs + 'ms')}; ` +
                'continuing anyway (ACME preflight may still fail).'
            );
            return null;
        }

        log.info(
            (isLinodeProvider
                ? 'Automatic DNS provider mode detected.'
                : 'Non-interactive mode (or autoContinue) detected. Set the TXT record now.') +
            ' Continuing automatically in ' +
            effectiveDelay +
            'ms...'
        );
        await sleep(effectiveDelay);
        return null;
    }

    async function getChallenge(opts) {
        const ch = opts?.challenge || {};
        const altname = String(ch.altname || opts?.altname || '');
        const wildcardZone = altname.startsWith('*.') ? altname.slice(2) : '';
        const dnsHostFromAltname = wildcardZone ? `_acme-challenge.${wildcardZone}` : '';
        const dnsHost = String(ch.dnsHost || opts?.dnsHost || dnsHostFromAltname || '');

        const byAltname = altname ? presentedByAltname.get(altname) : null;
        const dnsAuthorization =
            ch.dnsAuthorization ||
            opts?.dnsAuthorization ||
            (dnsHost ? presentedByHost.get(dnsHost) : null) ||
            byAltname?.dnsAuthorization ||
            null;

        if (!dnsAuthorization) {
            return null;
        }

        return {
            ...(typeof ch === 'object' ? ch : {}),
            ...(altname ? { altname } : {}),
            ...(dnsHost ? { dnsHost } : {}),
            dnsAuthorization
        };
    }

    async function removeChallenge(opts) {
        const ch = opts?.challenge || {};
        const altname = String(ch.altname || opts?.altname || '');
        const wildcardZone = altname.startsWith('*.') ? altname.slice(2) : '';
        const dnsHostFromAltname = wildcardZone ? `_acme-challenge.${wildcardZone}` : '';
        const dnsHost = String(ch.dnsHost || opts?.dnsHost || dnsHostFromAltname || '');

        if (isLinodeProvider && dnsHost) {
            try {
                const removed = await linodeRemoveTxtRecord(dnsHost);
                if (removed) {
                    log.info(`Linode DNS TXT removed for ${dnsHost}`);
                }
                return null;
            } catch (error) {
                log.warn(`Failed to remove Linode DNS TXT for ${dnsHost}: ${error?.message || error}`);
                return null;
            }
        }

        const legacyRemove = toPromise(challenger.remove, challenger);
        return legacyRemove(opts);
    }

    const wrapped = {
        propagationDelay,
        set: setChallenge,
        remove: removeChallenge,
        get: getChallenge,
        zones: async (opts) => {
            const dnsHost =
                opts?.dnsHost ||
                opts?.challenge?.dnsHost ||
                opts?.challenge?.altname ||
                opts?.altname;

            if (!dnsHost || typeof dnsHost !== 'string') {
                return [];
            }

            // Best-effort root zone extraction for legacy/manual flow.
            const zone = dnsHost
                .replace(/^_acme-challenge\./, '')
                .replace(/^_greenlock-[^.]+\./, '')
                .replace(/\.$/, '');

            return zone ? [zone] : [];
        }
    };

    if (typeof challenger.init === 'function') {
        wrapped.init = toPromise(challenger.init, challenger);
    }

    if (challenger.options && typeof challenger.options === 'object') {
        wrapped.options = { ...challenger.options };
    }

    return wrapped;
};
