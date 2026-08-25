'use strict';

const PHP_PATH = /(?:^|\/)[^/]*\.php(?:$|\/)/i;
const SCANNER_PATH = /(?:^|\/)(?:\.git|\.hg|\.svn|\.ssh|\.aws|cgi-bin|server-status|vendor\/phpunit|wp-admin|wp-content|wp-includes|wp-json)(?:\/|$)/i;
const SCANNER_FILE = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.htaccess|composer\.(?:json|lock)|web\.config)(?:\/|$)/i;

function requirePositiveInteger(options, name) {
    const value = options[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

function normalizeRequestPath(url) {
    let requestPath = String(url || '/').split(/[?#]/, 1)[0];
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const decoded = decodeURIComponent(requestPath);
            if (decoded === requestPath) break;
            requestPath = decoded;
        } catch {
            break;
        }
    }
    return requestPath.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

function scannerReason(url) {
    const requestPath = normalizeRequestPath(url);
    if (PHP_PATH.test(requestPath)) return 'php-path';
    if (SCANNER_PATH.test(requestPath)) return 'scanner-path';
    if (SCANNER_FILE.test(requestPath)) return 'sensitive-file';
    return null;
}

function normalizeIp(value) {
    const ip = String(value || '').trim();
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function clientIp(req, trustProxy) {
    if (trustProxy) {
        const forwardedFor = req.headers?.['x-forwarded-for'];
        const firstForwardedIp = Array.isArray(forwardedFor)
            ? forwardedFor[0]
            : String(forwardedFor || '').split(',')[0];
        const normalizedForwardedIp = normalizeIp(firstForwardedIp);
        if (normalizedForwardedIp) return normalizedForwardedIp;
    }
    return normalizeIp(req.socket?.remoteAddress);
}

function rejectRequest(req, res) {
    const body = 'Not Found';
    res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
}

function createScannerBlocker(options = {}) {
    if (!options || typeof options !== 'object') {
        throw new Error('scanner-blocker options must be an object');
    }

    const {
        windowMs = 60_000,
        strikeThreshold = 3,
        banDurationMs = 15 * 60_000,
        maxTrackedClients = 10_000,
        trustProxy = false,
        onBlock,
        now
    } = options;
    const normalizedOptions = { windowMs, strikeThreshold, banDurationMs, maxTrackedClients };
    requirePositiveInteger(normalizedOptions, 'windowMs');
    requirePositiveInteger(normalizedOptions, 'strikeThreshold');
    requirePositiveInteger(normalizedOptions, 'banDurationMs');
    requirePositiveInteger(normalizedOptions, 'maxTrackedClients');
    if (typeof trustProxy !== 'boolean') {
        throw new Error('trustProxy must be a boolean');
    }
    if (onBlock !== undefined && typeof onBlock !== 'function') {
        throw new Error('onBlock must be a function');
    }
    if (now !== undefined && typeof now !== 'function') {
        throw new Error('now must be a function');
    }

    const clock = now || Date.now;
    const clients = new Map();

    function removeExpiredClients(timestamp) {
        for (const [ip, state] of clients) {
            const banExpired = state.bannedUntil !== null && timestamp >= state.bannedUntil;
            const windowExpired = state.bannedUntil === null && timestamp - state.windowStartedAt >= windowMs;
            if (banExpired || windowExpired) clients.delete(ip);
        }
    }

    function addClient(ip, state, timestamp) {
        if (!clients.has(ip) && clients.size >= maxTrackedClients) {
            removeExpiredClients(timestamp);
        }
        if (!clients.has(ip) && clients.size >= maxTrackedClients) {
            clients.delete(clients.keys().next().value);
        }
        clients.delete(ip);
        clients.set(ip, state);
    }

    function reportBlock(details) {
        if (onBlock) onBlock(details);
    }

    return function scannerBlocker(req, res, context = {}) {
        const timestamp = clock();
        const ip = clientIp(req, trustProxy);
        let state = ip ? clients.get(ip) : null;

        if (state && state.bannedUntil !== null) {
            if (timestamp < state.bannedUntil) {
                rejectRequest(req, res);
                reportBlock({
                    type: 'banned-client',
                    clientIp: ip,
                    host: context.host || '',
                    url: req.url || '/',
                    bannedUntil: state.bannedUntil
                });
                return true;
            }
            clients.delete(ip);
            state = null;
        }

        const reason = scannerReason(req.url);
        if (!reason) return false;

        let bannedUntil = null;
        if (ip) {
            if (!state || timestamp - state.windowStartedAt >= windowMs) {
                state = { strikes: 0, windowStartedAt: timestamp, bannedUntil: null };
            }
            state.strikes += 1;
            if (state.strikes >= strikeThreshold) {
                state.bannedUntil = timestamp + banDurationMs;
            }
            bannedUntil = state.bannedUntil;
            addClient(ip, state, timestamp);
        }

        rejectRequest(req, res);
        reportBlock({
            type: 'scanner-path',
            reason,
            clientIp: ip,
            host: context.host || '',
            url: req.url || '/',
            bannedUntil
        });
        return true;
    };
}

module.exports = { createScannerBlocker };
