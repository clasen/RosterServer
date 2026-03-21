const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const Greenlock = require('./vendor/greenlock-express/greenlock-express.js');
const GreenlockShim = require('./vendor/greenlock-express/greenlock-shim.js');
const { resolveSiteApp } = require('./lib/resolve-site-app.js');
const log = require('lemonlog')('roster');

const isBunRuntime = typeof Bun !== 'undefined' || (typeof process !== 'undefined' && process.release?.name === 'bun');

// CRC32 implementation for deterministic port assignment
function crc32(str) {
    const crcTable = [];
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
        }
        crcTable[i] = crc;
    }

    let crc = 0xFFFFFFFF;
    for (let i = 0; i < str.length; i++) {
        const byte = str.charCodeAt(i);
        crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Convert CRC32 hash to a port number in available range
function domainToPort(domain, minPort = 3000, maxPort = 65535) {
    const hash = crc32(domain);
    const portRange = maxPort - minPort + 1;
    return minPort + (hash % portRange);
}

// Wildcard helpers: *.example.com -> root "example.com"
function wildcardRoot(pattern) {
    if (!pattern || !pattern.startsWith('*.')) return null;
    return pattern.split('.').slice(1).join('.');
}

// Check if host matches wildcard pattern (e.g. api.example.com matches *.example.com)
function hostMatchesWildcard(host, pattern) {
    if (!pattern || !pattern.startsWith('*.')) return false;
    const h = (host || '').toLowerCase();
    const suffix = pattern.slice(2).toLowerCase(); // "example.com"
    return h.endsWith('.' + suffix) && h.length > suffix.length;
}

function wildcardSubjectForHost(host) {
    const normalized = (host || '').trim().toLowerCase();
    const labels = normalized.split('.').filter(Boolean);
    if (labels.length < 3) return null;
    return `*.${labels.slice(1).join('.')}`;
}

function certDirCandidatesForSubject(subject) {
    const normalized = (subject || '').trim().toLowerCase();
    if (!normalized) return [];
    if (!normalized.startsWith('*.')) return [normalized];
    const zone = wildcardRoot(normalized);
    if (!zone) return [normalized];
    // greenlock-store-fs may persist wildcard subjects under _wildcard_.<zone>
    return [normalized, `_wildcard_.${zone}`];
}

function buildCertLookupCandidates(servername) {
    const normalized = (servername || '').trim().toLowerCase();
    if (!normalized) return [];

    const subjects = [normalized];
    const wildcardSubject = wildcardSubjectForHost(normalized);
    if (wildcardSubject) subjects.push(wildcardSubject);
    const zoneSubject = wildcardRoot(normalized) || (wildcardSubject ? wildcardRoot(wildcardSubject) : null);
    if (zoneSubject) subjects.push(zoneSubject);

    const candidates = [];
    const seen = new Set();
    for (const subject of subjects) {
        for (const certDir of certDirCandidatesForSubject(subject)) {
            if (seen.has(certDir)) continue;
            seen.add(certDir);
            candidates.push(certDir);
        }
    }
    return candidates;
}

function certCoversName(certPem, name) {
    try {
        const x509 = new crypto.X509Certificate(certPem);
        const san = (x509.subjectAltName || '').toLowerCase();
        return san.split(',').some(entry => entry.trim() === `dns:${name.toLowerCase()}`);
    } catch {
        return false;
    }
}

function parseBooleanFlag(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function normalizeDomainForLocalHost(domain) {
    return (domain || '').trim().toLowerCase().replace(/^www\./, '');
}

function localHostForDomain(normalizedDomain) {
    const normalized = normalizedDomain;
    if (!normalized) return 'localhost';
    if (normalized.startsWith('*.')) return '*.localhost';
    const labels = normalized.split('.').filter(Boolean);
    if (labels.length > 2) return `${labels.slice(0, -2).join('.')}.localhost`;
    return 'localhost';
}

// Virtual Server that completely isolates applications
class VirtualServer extends EventEmitter {
    constructor(domain) {
        super();
        this.domain = domain;
        this.requestListeners = [];
        this.upgradeListeners = [];

        // Simulate http.Server properties
        this.listening = false;
        this.address = () => ({ port: 443, family: 'IPv4', address: '0.0.0.0' });
        this.timeout = 0;
        this.keepAliveTimeout = 5000;
        this.headersTimeout = 60000;
        this.maxHeadersCount = null;
    }

    // Override listener methods to capture them
    on(event, listener) {
        if (event === 'request') {
            this.requestListeners.push(listener);
        } else if (event === 'upgrade') {
            this.upgradeListeners.push(listener);
        }
        return super.on(event, listener);
    }

    addListener(event, listener) {
        return this.on(event, listener);
    }

    // Socket.IO compatibility methods
    listeners(event) {
        if (event === 'request') {
            return this.requestListeners.slice();
        } else if (event === 'upgrade') {
            return this.upgradeListeners.slice();
        }
        return super.listeners(event);
    }

    removeListener(event, listener) {
        if (event === 'request') {
            const index = this.requestListeners.indexOf(listener);
            if (index !== -1) {
                this.requestListeners.splice(index, 1);
            }
        } else if (event === 'upgrade') {
            const index = this.upgradeListeners.indexOf(listener);
            if (index !== -1) {
                this.upgradeListeners.splice(index, 1);
            }
        }
        return super.removeListener(event, listener);
    }

    removeAllListeners(event) {
        if (event === 'request') {
            this.requestListeners = [];
        } else if (event === 'upgrade') {
            this.upgradeListeners = [];
        }
        return super.removeAllListeners(event);
    }

    // Simulate other http.Server methods
    listen() { this.listening = true; return this; }
    close() { this.listening = false; return this; }
    setTimeout() { return this; }

    // Process request with this virtual server's listeners
    processRequest(req, res) {
        let handled = false;

        // Track if response was handled
        const originalEnd = res.end;
        res.end = function (...args) {
            handled = true;
            return originalEnd.apply(this, args);
        };

        // Try all listeners
        for (const listener of this.requestListeners) {
            if (!handled) {
                listener(req, res);
            }
        }

        // Restore original end method
        res.end = originalEnd;

        // If no listener handled the request, try fallback handler
        if (!handled && this.fallbackHandler) {
            this.fallbackHandler(req, res);
        } else if (!handled) {
            res.writeHead(404);
            res.end('No handler found');
        }
    }

    // Process upgrade events (WebSocket)
    processUpgrade(req, socket, head) {
        // Emit to all registered upgrade listeners
        for (const listener of this.upgradeListeners) {
            listener(req, socket, head);
        }

        // If no listeners, destroy the socket
        if (this.upgradeListeners.length === 0) {
            socket.destroy();
        }
    }
}

class Roster {
    constructor(options = {}) {
        this.email = options.email || 'admin@example.com';
        const basePath = options.basePath || path.join(__dirname, '..', '..', '..');
        this.wwwPath = options.wwwPath || path.join(basePath, 'www');
        this.greenlockStorePath = options.greenlockStorePath || path.join(basePath, 'greenlock.d');
        this.staging = options.staging || false;
        this.cluster = options.cluster || false;
        this.local = options.local || false;
        this.domains = [];
        this.sites = {};
        this.wildcardZones = new Set(); // Root domains that have a wildcard site (e.g. "example.com" for *.example.com)
        this.domainServers = {}; // Store separate servers for each domain
        this.portServers = {}; // Store servers by port
        this.domainPorts = {}; // Store domain → port mapping for local mode
        this.assignedPorts = new Set(); // Track ports assigned to domains (not OS availability)
        this._sitesByPort = {};
        this._initialized = false;
        this._sniCallback = null;
        this.hostname = options.hostname ?? '::';
        this.filename = options.filename || 'index';
        this.minLocalPort = options.minLocalPort || 4000;
        this.maxLocalPort = options.maxLocalPort || 9999;
        this.tlsMinVersion = options.tlsMinVersion ?? 'TLSv1.2';
        this.tlsMaxVersion = options.tlsMaxVersion ?? 'TLSv1.3';
        this.disableWildcard = parseBooleanFlag(options.disableWildcard, false);
        this.combineWildcardCerts = parseBooleanFlag(options.combineWildcardCerts, false);
        if (isBunRuntime && this.combineWildcardCerts) {
            log.info('Bun runtime detected: combined wildcard certificates enabled (SNI bypass)');
        }

        this.skipLocalCheck = parseBooleanFlag(options.skipLocalCheck, true);
        this.autoCertificates = parseBooleanFlag(options.autoCertificates, true);
        this.certificateRenewIntervalMs = Number.isFinite(Number(options.certificateRenewIntervalMs))
            ? Math.max(60000, Number(options.certificateRenewIntervalMs))
            : 12 * 60 * 60 * 1000;
        this._greenlockRuntime = null;
        this._certificateRenewTimer = null;

        const port = options.port === undefined ? 443 : options.port;
        if (port === 80 && !this.local) {
            throw new Error('⚠️  Port 80 is reserved for ACME challenge. Please use a different port.');
        }
        this.defaultPort = port;
        // Use a local wrapper around acme-dns-01-cli so we can provide propagationDelay,
        // zones(), and Promise-style signatures expected by newer ACME validators.
        const defaultDnsChallengeModule = path.join(__dirname, 'vendor', 'acme-dns-01-cli-wrapper.js');
        const shouldUseCliWrapper = (moduleName) =>
            typeof moduleName === 'string' &&
            /(^|[\\/])acme-dns-01-cli([\\/]|$)/.test(moduleName);

        if (options.dnsChallenge === false) {
            this.dnsChallenge = null;
        } else if (options.dnsChallenge) {
            const provided = { ...options.dnsChallenge };
            if (shouldUseCliWrapper(provided.module) || provided.module === 'acme-dns-01-cli') {
                provided.module = defaultDnsChallengeModule;
            }
            if (provided.propagationDelay === undefined) {
                provided.propagationDelay = 120000;
            }
            if (provided.autoContinue === undefined) {
                provided.autoContinue = false;
            }
            if (provided.dryRunDelay === undefined) {
                provided.dryRunDelay = provided.propagationDelay;
            }
            this.dnsChallenge = provided;
        } else {
            this.dnsChallenge = {
                module: defaultDnsChallengeModule,
                propagationDelay: 120000,
                autoContinue: false,
                dryRunDelay: 120000
            };
        }
    }

    async loadSites() {
        // Check if wwwPath exists
        if (!fs.existsSync(this.wwwPath)) {
            log.warn(`⚠️  WWW path does not exist: ${this.wwwPath}`);
            return;
        }

        const sites = fs.readdirSync(this.wwwPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory());

        for (const dirent of sites) {
            const domain = dirent.name;
            const domainPath = path.join(this.wwwPath, domain);

            let resolved;
            try {
                resolved = await resolveSiteApp(domainPath, { filename: this.filename });
            } catch (err) {
                log.warn(`⚠️  Error loading site in ${domainPath}:`, err);
                continue;
            }

            if (!resolved) {
                log.warn(`⚠️  No index file (js/mjs/cjs or index.html) found in ${domainPath}`);
                continue;
            }

            const { siteApp, type } = resolved;

            if (domain.startsWith('*.')) {
                if (this.disableWildcard) {
                    log.warn(`⚠️  Wildcard site skipped (disableWildcard enabled): ${domain}`);
                    continue;
                }
                this.domains.push(domain);
                this.sites[domain] = siteApp;
                const root = wildcardRoot(domain);
                if (root) this.wildcardZones.add(root);
                log.info(`(✔) Loaded wildcard site: https://${domain}${type === 'static' ? ' (static)' : ''}`);
            } else {
                const domainEntries = [domain, `www.${domain}`];
                this.domains.push(...domainEntries);
                domainEntries.forEach(d => {
                    this.sites[d] = siteApp;
                });
                log.info(`(✔) Loaded site: https://${domain}${type === 'static' ? ' (static)' : ''}`);
            }
        }
    }

    generateConfigJson() {
        const configDir = this.greenlockStorePath;
        const configPath = path.join(configDir, 'config.json');

        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        const sitesConfig = [];
        const uniqueDomains = new Set();

        this.domains.forEach(domain => {
            const root = domain.startsWith('*.') ? wildcardRoot(domain) : domain.replace(/^www\./, '');
            if (root) uniqueDomains.add(root);
        });

        let existingConfig = {};
        if (fs.existsSync(configPath)) {
            const currentConfigContent = fs.readFileSync(configPath, 'utf8');
            existingConfig = JSON.parse(currentConfigContent);
        }

        uniqueDomains.forEach(domain => {
            const applyRenewAtIfUnchanged = (siteConfig, existingSite) => {
                if (!existingSite || !existingSite.renewAt) return;
                const existingAltnames = Array.isArray(existingSite.altnames)
                    ? [...existingSite.altnames].sort()
                    : [];
                const nextAltnames = Array.isArray(siteConfig.altnames)
                    ? [...siteConfig.altnames].sort()
                    : [];
                const sameAltnames =
                    existingAltnames.length === nextAltnames.length &&
                    existingAltnames.every((name, idx) => name === nextAltnames[idx]);
                if (sameAltnames) {
                    siteConfig.renewAt = existingSite.renewAt;
                }
            };

            // Primary cert for apex/www uses default challenge flow (typically http-01).
            const primaryAltnames = [domain];
            if ((domain.match(/\./g) || []).length < 2) {
                primaryAltnames.push(`www.${domain}`);
            }
            const shouldCombineWildcard = this.combineWildcardCerts && this.wildcardZones.has(domain) && this.dnsChallenge;
            if (shouldCombineWildcard) {
                primaryAltnames.push(`*.${domain}`);
            }
            const primarySite = {
                subject: domain,
                altnames: primaryAltnames
            };
            if (shouldCombineWildcard) {
                const dns01 = { ...this.dnsChallenge };
                if (dns01.propagationDelay === undefined) dns01.propagationDelay = 60000;
                if (dns01.autoContinue === undefined) dns01.autoContinue = false;
                if (dns01.dryRunDelay === undefined) dns01.dryRunDelay = dns01.propagationDelay;
                primarySite.challenges = { 'dns-01': dns01 };
            }
            const existingPrimarySite = Array.isArray(existingConfig.sites)
                ? existingConfig.sites.find(site => site.subject === domain)
                : null;
            applyRenewAtIfUnchanged(primarySite, existingPrimarySite);
            sitesConfig.push(primarySite);

            // Wildcard cert is issued separately and uses dns-01 only.
            if (!shouldCombineWildcard && this.wildcardZones.has(domain) && this.dnsChallenge) {
                const wildcardSubject = `*.${domain}`;
                const dns01 = { ...this.dnsChallenge };
                if (dns01.propagationDelay === undefined) {
                    dns01.propagationDelay = 60000; // 120s default for manual DNS (acme-dns-01-cli)
                }
                if (dns01.autoContinue === undefined) {
                    dns01.autoContinue = false;
                }
                if (dns01.dryRunDelay === undefined) {
                    dns01.dryRunDelay = dns01.propagationDelay;
                }
                const wildcardSite = {
                    subject: wildcardSubject,
                    altnames: [wildcardSubject],
                    challenges: {
                        'dns-01': dns01
                    }
                };
                const existingWildcardSite = Array.isArray(existingConfig.sites)
                    ? existingConfig.sites.find(site => site.subject === wildcardSubject)
                    : null;
                applyRenewAtIfUnchanged(wildcardSite, existingWildcardSite);
                sitesConfig.push(wildcardSite);
            }
        });

        const newConfig = {
            defaults: {
                store: {
                    module: "greenlock-store-fs",
                    basePath: this.greenlockStorePath
                },
                challenges: {
                    "http-01": {
                        module: "acme-http-01-standalone"
                    }
                },
                renewOffset: "-45d",
                renewStagger: "3d",
                accountKeyType: "EC-P256",
                serverKeyType: "RSA-2048",
                subscriberEmail: this.email
            },
            sites: sitesConfig
        };

        if (fs.existsSync(configPath)) {
            const currentConfigContent = fs.readFileSync(configPath, 'utf8');
            const currentConfig = JSON.parse(currentConfigContent);

            const newConfigContent = JSON.stringify(newConfig, null, 2);
            const currentConfigContentFormatted = JSON.stringify(currentConfig, null, 2);

            if (newConfigContent === currentConfigContentFormatted) {
                log.info('ℹ️  Configuration has not changed. config.json will not be overwritten.');
                return;
            }
            log.info('🔄  Configuration has changed. config.json will be updated.');
        } else {
            log.info('🆕  config.json does not exist. A new one will be created.');
        }

        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
        log.info(`📁  config.json generated at ${configPath}`);
    }

    /**
     * Resolve handler for a host (exact match, then wildcard). Used when port is not in the key.
     */
    getHandlerForHost(host) {
        const resolved = this.getHandlerAndKeyForHost(host);
        return resolved ? resolved.handler : null;
    }

    /**
     * Resolve handler and site key for a host (exact match, then wildcard). Used by getUrl for wildcard lookups.
     */
    getHandlerAndKeyForHost(host) {
        const siteApp = this.sites[host];
        if (siteApp) return { handler: siteApp, siteKey: host };
        for (const key of Object.keys(this.sites)) {
            if (key.startsWith('*.')) {
                const pattern = key.split(':')[0];
                if (hostMatchesWildcard(host, pattern)) return { handler: this.sites[key], siteKey: key };
            }
        }
        return null;
    }

    /**
     * Resolve virtualServer and appHandler for a host from portData (exact then wildcard).
     */
    getHandlerForPortData(host, portData) {
        const virtualServer = portData.virtualServers[host];
        const appHandler = portData.appHandlers[host];
        if (virtualServer && appHandler !== undefined) return { virtualServer, appHandler };
        for (const key of Object.keys(portData.appHandlers)) {
            if (key.startsWith('*.') && hostMatchesWildcard(host, key)) {
                return {
                    virtualServer: portData.virtualServers[key],
                    appHandler: portData.appHandlers[key]
                };
            }
        }
        return null;
    }

    handleRequest(req, res) {
        const host = req.headers.host || '';

        if (host.startsWith('www.')) {
            const newHost = host.slice(4);
            res.writeHead(301, { Location: `https://${newHost}${req.url}` });
            res.end();
            return;
        }

        const hostWithoutPort = host.split(':')[0];
        const siteApp = this.getHandlerForHost(hostWithoutPort);
        if (siteApp) {
            siteApp(req, res);
        } else {
            res.writeHead(404);
            res.end('Site not found');
        }
    }

    register(domainString, requestHandler) {
        if (!domainString) {
            throw new Error('Domain is required');
        }
        if (typeof requestHandler !== 'function') {
            throw new Error('requestHandler must be a function');
        }

        const { domain, port } = this.parseDomainWithPort(domainString);

        if (domain.startsWith('*.')) {
            if (this.disableWildcard) {
                log.warn(`⚠️  Wildcard registration ignored (disableWildcard enabled): ${domain}`);
                return this;
            }
            const domainKey = port === this.defaultPort ? domain : `${domain}:${port}`;
            this.domains.push(domain);
            this.sites[domainKey] = requestHandler;
            const root = wildcardRoot(domain);
            if (root) this.wildcardZones.add(root);
            log.info(`(✔) Registered wildcard site: ${domain}${port !== this.defaultPort ? ':' + port : ''}`);
            return this;
        }

        const domainEntries = [domain];
        if ((domain.match(/\./g) || []).length < 2) {
            domainEntries.push(`www.${domain}`);
        }

        this.domains.push(...domainEntries);
        domainEntries.forEach(d => {
            const domainKey = port === this.defaultPort ? d : `${d}:${port}`;
            this.sites[domainKey] = requestHandler;
        });

        log.info(`(✔) Registered site: ${domain}${port !== this.defaultPort ? ':' + port : ''}`);
        return this;
    }

    parseDomainWithPort(domainString) {
        const parts = domainString.split(':');
        if (parts.length === 2) {
            const domain = parts[0];
            const port = parseInt(parts[1]);
            if (port === 80 && !this.local) {
                throw new Error('⚠️  Port 80 is reserved for ACME challenge. Please use a different port.');
            }
            return { domain, port };
        }
        return { domain: domainString, port: this.defaultPort };
    }

    /**
     * Get the URL for a domain based on the current environment
     * @param {string} domain - The domain name (or subdomain that matches a wildcard site)
     * @returns {string|null} The URL if domain is registered (exact or wildcard), null otherwise
     */
    getUrl(domain) {
        const cleanDomain = normalizeDomainForLocalHost(domain);

        const exactMatch = this.sites[cleanDomain] || this.sites[`www.${cleanDomain}`];
        const resolved = exactMatch ? { handler: exactMatch, siteKey: cleanDomain } : this.getHandlerAndKeyForHost(cleanDomain);
        if (!resolved) return null;

        if (this.local) {
            const pattern = resolved.siteKey.split(':')[0];
            if (this.domainPorts && this.domainPorts[pattern] !== undefined) {
                return `http://${localHostForDomain(cleanDomain)}:${this.domainPorts[pattern]}`;
            }
            return null;
        }
        const port = this.defaultPort === 443 ? '' : `:${this.defaultPort}`;
        return `https://${cleanDomain}${port}`;
    }

    createVirtualServer(domain) {
        return new VirtualServer(domain);
    }

    // Assign port to domain, detecting collisions with already assigned ports
    assignPortToDomain(domain) {
        let port = domainToPort(domain, this.minLocalPort, this.maxLocalPort);

        // If port is already assigned to another domain, increment until we find a free one
        while (this.assignedPorts.has(port)) {
            port++;
            if (port > this.maxLocalPort) {
                port = this.minLocalPort; // Wrap around if we exceed max port
            }
        }

        this.assignedPorts.add(port);
        return port;
    }

    // Get SSL context from Greenlock for custom ports
    async getSSLContext(domain, greenlock) {
        try {
            // Try to get existing certificate for the domain
            const site = await greenlock.get({ servername: domain });
            if (site && site.pems) {
                return {
                    key: site.pems.privkey,
                    cert: site.pems.cert + site.pems.chain
                };
            }
        } catch (error) {
        }

        // Return undefined to let HTTPS server handle SNI callback
        return null;
    }

    _normalizeHostInput(value) {
        if (typeof value === 'string') return value;
        if (!value || typeof value !== 'object') return '';
        if (typeof value.servername === 'string') return value.servername;
        if (typeof value.hostname === 'string') return value.hostname;
        if (typeof value.subject === 'string') return value.subject;
        return '';
    }

    _loadCert(subjectDir) {
        const normalizedSubject = this._normalizeHostInput(subjectDir).trim().toLowerCase();
        if (!normalizedSubject) return null;
        const certPath = path.join(this.greenlockStorePath, 'live', normalizedSubject);
        const keyPath = path.join(certPath, 'privkey.pem');
        const certFilePath = path.join(certPath, 'cert.pem');
        const chainPath = path.join(certPath, 'chain.pem');
        if (fs.existsSync(keyPath) && fs.existsSync(certFilePath) && fs.existsSync(chainPath)) {
            return {
                key: fs.readFileSync(keyPath, 'utf8'),
                cert: fs.readFileSync(certFilePath, 'utf8') + fs.readFileSync(chainPath, 'utf8')
            };
        }
        return null;
    }

    _resolvePemsForServername(servername) {
        const host = this._normalizeHostInput(servername).trim().toLowerCase();
        if (!host) return null;
        const candidates = buildCertLookupCandidates(host);
        for (const candidate of candidates) {
            const pems = this._loadCert(candidate);
            if (pems) return pems;
        }
        return null;
    }

    _initSiteHandlers() {
        this._sitesByPort = {};
        for (const [hostKey, siteApp] of Object.entries(this.sites)) {
            if (hostKey.startsWith('www.')) continue;
            const { domain, port } = this.parseDomainWithPort(hostKey);
            if (!this._sitesByPort[port]) {
                this._sitesByPort[port] = {
                    virtualServers: {},
                    appHandlers: {}
                };
            }

            const virtualServer = this.createVirtualServer(domain);
            this._sitesByPort[port].virtualServers[domain] = virtualServer;
            this.domainServers[domain] = virtualServer;

            const appHandler = siteApp(virtualServer);
            this._sitesByPort[port].appHandlers[domain] = appHandler;
            if (!domain.startsWith('*.')) {
                this._sitesByPort[port].appHandlers[`www.${domain}`] = appHandler;
            }
        }
    }

    _createDispatcher(portData) {
        return (req, res) => {
            const host = req.headers.host || '';
            const hostWithoutPort = host.split(':')[0].toLowerCase();
            const domain = hostWithoutPort.startsWith('www.') ? hostWithoutPort.slice(4) : hostWithoutPort;

            if (hostWithoutPort.startsWith('www.')) {
                const protocol = this.local ? 'http' : 'https';
                res.writeHead(301, { Location: `${protocol}://${domain}${req.url}` });
                res.end();
                return;
            }

            const resolved = this.getHandlerForPortData(domain, portData);
            if (!resolved) {
                res.writeHead(404);
                res.end('Site not found');
                return;
            }
            const { virtualServer, appHandler } = resolved;

            if (virtualServer && virtualServer.requestListeners.length > 0) {
                virtualServer.fallbackHandler = appHandler;
                virtualServer.processRequest(req, res);
            } else if (appHandler) {
                appHandler(req, res);
            } else {
                res.writeHead(404);
                res.end('Site not found');
            }
        };
    }

    _createUpgradeHandler(portData) {
        return (req, socket, head) => {
            const host = req.headers.host || '';
            const hostWithoutPort = host.split(':')[0].toLowerCase();
            const domain = hostWithoutPort.startsWith('www.') ? hostWithoutPort.slice(4) : hostWithoutPort;

            const resolved = this.getHandlerForPortData(domain, portData);
            if (resolved && resolved.virtualServer) {
                resolved.virtualServer.processUpgrade(req, socket, head);
            } else {
                socket.destroy();
            }
        };
    }

    _initSniResolver() {
        this._sniCallback = (servername, callback) => {
            const normalizedServername = this._normalizeHostInput(servername).trim().toLowerCase();
            try {
                const pems = this._resolvePemsForServername(normalizedServername);
                if (pems) {
                    callback(null, tls.createSecureContext({ key: pems.key, cert: pems.cert }));
                    return;
                }
            } catch (error) {
                callback(error);
                return;
            }

            // Cluster-friendly automatic issuance path (no internal listen lifecycle).
            if (!this._greenlockRuntime || !normalizedServername) {
                callback(new Error(`No certificate files available for ${servername}`));
                return;
            }

            this._greenlockRuntime.get({ servername: normalizedServername })
                .then(() => {
                    const issued = this._resolvePemsForServername(normalizedServername);
                    if (issued) {
                        callback(null, tls.createSecureContext({ key: issued.key, cert: issued.cert }));
                    } else {
                        callback(new Error(`No certificate files available for ${servername}`));
                    }
                })
                .catch((error) => {
                    callback(error);
                });
        };
    }

    _buildGreenlockOptions() {
        return {
            packageRoot: __dirname,
            configDir: this.greenlockStorePath,
            maintainerEmail: this.email,
            cluster: this.cluster,
            staging: this.staging,
            skipDryRun: this.skipLocalCheck,
            skipChallengeTest: this.skipLocalCheck,
            notify: (event, details) => {
                const eventDomain = (() => {
                    if (!details || typeof details !== 'object') return null;

                    const directKeys = ['subject', 'servername', 'domain', 'hostname', 'host'];
                    for (const key of directKeys) {
                        if (typeof details[key] === 'string' && details[key].trim()) {
                            return details[key].trim().toLowerCase();
                        }
                    }

                    if (Array.isArray(details.altnames) && details.altnames.length > 0) {
                        const alt = details.altnames.find(name => typeof name === 'string' && name.trim());
                        if (alt) return alt.trim().toLowerCase();
                    }

                    if (Array.isArray(details.domains) && details.domains.length > 0) {
                        const domain = details.domains.find(name => typeof name === 'string' && name.trim());
                        if (domain) return domain.trim().toLowerCase();
                    }

                    if (details.identifier && typeof details.identifier.value === 'string' && details.identifier.value.trim()) {
                        return details.identifier.value.trim().toLowerCase();
                    }

                    return null;
                })();

                let msg;
                if (typeof details === 'string') {
                    msg = details;
                } else if (details instanceof Error) {
                    msg = details.stack || details.message;
                } else if (details && typeof details === 'object' && typeof details.message === 'string') {
                    msg = details.message;
                } else {
                    try {
                        msg = JSON.stringify(details);
                    } catch {
                        msg = String(details);
                    }
                }
                if (!msg || msg === 'undefined') msg = `[${event}] (no details)`;
                if (eventDomain && !msg.includes(`[${eventDomain}]`)) {
                    msg = `[${eventDomain}] ${msg}`;
                }
                if (event === 'warning' && typeof msg === 'string') {
                    if (/acme-dns-01-cli.*(incorrect function signatures|deprecated use of callbacks)/i.test(msg)) return;
                    if (/dns-01 challenge plugin should have zones/i.test(msg)) return;
                }
                if (event === 'error') log.error(msg);
                else if (event === 'warning') log.warn(msg);
                else log.info(msg);
            }
        };
    }

    _getManagedCertificateSubjects() {
        const uniqueDomains = new Set();
        this.domains.forEach((domain) => {
            const root = domain.startsWith('*.') ? wildcardRoot(domain) : domain.replace(/^www\./, '');
            if (root) uniqueDomains.add(root);
        });
        const subjects = [];
        uniqueDomains.forEach((domain) => {
            subjects.push(domain);
            const includeWildcard = this.wildcardZones.has(domain) && this.dnsChallenge && !this.combineWildcardCerts;
            if (includeWildcard) subjects.push(`*.${domain}`);
        });
        return [...new Set(subjects)];
    }

    _startCertificateRenewLoop() {
        if (!this._greenlockRuntime || this._certificateRenewTimer) return;
        const subjects = this._getManagedCertificateSubjects();
        if (subjects.length === 0) return;
        this._certificateRenewTimer = setInterval(() => {
            subjects.forEach((subject) => {
                this._greenlockRuntime.get({ servername: subject }).catch((error) => {
                    log.warn(`⚠️  Certificate renew check failed for ${subject}: ${error?.message || error}`);
                });
            });
        }, this.certificateRenewIntervalMs);
        if (typeof this._certificateRenewTimer.unref === 'function') {
            this._certificateRenewTimer.unref();
        }
    }

    async ensureCertificate(servername) {
        if (this.local) {
            throw new Error('ensureCertificate() is not available in local mode');
        }
        if (!this._initialized) {
            throw new Error('Call init() before ensureCertificate()');
        }
        const normalizedServername = this._normalizeHostInput(servername).trim().toLowerCase();
        if (!normalizedServername) {
            throw new Error('servername is required');
        }
        let pems = this._resolvePemsForServername(normalizedServername);
        if (pems) return pems;
        if (!this._greenlockRuntime) {
            throw new Error('autoCertificates is disabled; enable { autoCertificates: true } to issue certificates automatically');
        }
        await this._greenlockRuntime.get({ servername: normalizedServername });
        pems = this._resolvePemsForServername(normalizedServername);
        if (!pems) {
            throw new Error(`Certificate issuance completed but no PEM files were found for ${normalizedServername}`);
        }
        return pems;
    }

    loadCertificate(servername) {
        if (this.local) {
            throw new Error('loadCertificate() is not available in local mode');
        }
        if (!this._initialized) {
            throw new Error('Call init() before loadCertificate()');
        }
        const normalizedServername = this._normalizeHostInput(servername).trim().toLowerCase();
        if (!normalizedServername) {
            throw new Error('servername is required');
        }
        const pems = this._resolvePemsForServername(normalizedServername);
        if (!pems) {
            throw new Error(`No certificate files available for ${normalizedServername}`);
        }
        return pems;
    }

    async init() {
        if (this._initialized) return this;
        await this.loadSites();
        if (!this.local) {
            this.generateConfigJson();
            if (this.autoCertificates) {
                this._greenlockRuntime = GreenlockShim.create(this._buildGreenlockOptions());
            }
        }
        this._initSiteHandlers();
        if (!this.local) {
            this._initSniResolver();
            if (this.autoCertificates) {
                this._startCertificateRenewLoop();
            }
        }
        this._initialized = true;
        return this;
    }

    requestHandler(port) {
        if (!this._initialized) throw new Error('Call init() before requestHandler()');
        const targetPort = port || this.defaultPort;
        const portData = this._sitesByPort[targetPort];
        if (!portData) {
            return (req, res) => {
                res.writeHead(404);
                res.end('Site not found');
            };
        }
        return this._createDispatcher(portData);
    }

    upgradeHandler(port) {
        if (!this._initialized) throw new Error('Call init() before upgradeHandler()');
        const targetPort = port || this.defaultPort;
        const portData = this._sitesByPort[targetPort];
        if (!portData) {
            return (req, socket, head) => { socket.destroy(); };
        }
        return this._createUpgradeHandler(portData);
    }

    sniCallback() {
        if (!this._initialized) throw new Error('Call init() before sniCallback()');
        if (!this._sniCallback) throw new Error('SNI callback not available in local mode');
        return this._sniCallback;
    }

    attach(server, { port } = {}) {
        if (!this._initialized) throw new Error('Call init() before attach()');
        server.on('request', this.requestHandler(port));
        server.on('upgrade', this.upgradeHandler(port));
        return this;
    }

    async createManagedHttpsServer(options = {}) {
        if (this.local) throw new Error('createManagedHttpsServer() is not available in local mode');
        if (!this._initialized) throw new Error('Call init() before createManagedHttpsServer()');

        const {
            servername,
            port,
            ensureCertificate = true,
            tlsOptions = {}
        } = options;

        const normalizedServername = this._normalizeHostInput(servername).trim().toLowerCase();
        if (!normalizedServername) {
            throw new Error('servername is required');
        }

        const pems = ensureCertificate
            ? await this.ensureCertificate(normalizedServername)
            : this.loadCertificate(normalizedServername);

        const server = https.createServer({
            minVersion: this.tlsMinVersion,
            maxVersion: this.tlsMaxVersion,
            ...tlsOptions,
            key: pems.key,
            cert: pems.cert,
            SNICallback: this.sniCallback()
        });

        this.attach(server, { port });
        return server;
    }

    async createServingHttpsServer(options = {}) {
        return this.createManagedHttpsServer({
            ...options,
            ensureCertificate: false
        });
    }

    startLocalMode() {
        this.domainPorts = {};

        for (const portData of Object.values(this._sitesByPort)) {
            for (const [domain, virtualServer] of Object.entries(portData.virtualServers)) {
                if (domain.startsWith('www.')) continue;

                const port = this.assignPortToDomain(domain);
                this.domainPorts[domain] = port;

                const appHandler = portData.appHandlers[domain];

                const dispatcher = (req, res) => {
                    virtualServer.fallbackHandler = appHandler;
                    if (virtualServer.requestListeners.length > 0) {
                        virtualServer.processRequest(req, res);
                    } else if (appHandler) {
                        appHandler(req, res);
                    } else {
                        res.writeHead(404);
                        res.end('Site not found');
                    }
                };

                const httpServer = http.createServer(dispatcher);
                this.portServers[port] = httpServer;

                httpServer.on('upgrade', (req, socket, head) => {
                    virtualServer.processUpgrade(req, socket, head);
                });

                httpServer.listen(port, 'localhost', () => {
                    const cleanDomain = normalizeDomainForLocalHost(domain);
                    log.info(`🌐 ${domain} → http://${localHostForDomain(cleanDomain)}:${port}`);
                });

                httpServer.on('error', (error) => {
                    log.error(`❌ Error on port ${port} for ${domain}:`, error.message);
                });
            }
        }

        log.info(`(✔) Started ${Object.keys(this.portServers).length} sites in local mode`);
        return Promise.resolve();
    }

    async start() {
        await this.init();

        if (this.local) {
            return this.startLocalMode();
        }

        const greenlockOptions = this._buildGreenlockOptions();
        const greenlockRuntime = GreenlockShim.create(greenlockOptions);
        const greenlock = Greenlock.init({
            ...greenlockOptions,
            greenlock: greenlockRuntime
        });

        return greenlock.ready(async glx => {
            const httpServer = glx.httpServer();
            const bunTlsHotReloadHandlers = [];

            httpServer.listen(80, this.hostname, () => {
                log.info('HTTP server listening on port 80');
            });

            for (const [port, portData] of Object.entries(this._sitesByPort)) {
                const portNum = parseInt(port);
                const dispatcher = this._createDispatcher(portData);
                const upgradeHandler = this._createUpgradeHandler(portData);

                const issueAndReloadPemsForServername = async (servername) => {
                    const host = this._normalizeHostInput(servername).trim().toLowerCase();
                    if (!host) return null;

                    let pems = this._resolvePemsForServername(host);
                    if (pems) return pems;

                    try {
                        await greenlockRuntime.get({ servername: host });
                    } catch (error) {
                        log.warn(`⚠️  Greenlock issuance failed for ${host}: ${error?.message || error}`);
                    }

                    pems = this._resolvePemsForServername(host);
                    if (pems) return pems;

                    const wildcardSubject = wildcardSubjectForHost(host);
                    const zone = wildcardSubject ? wildcardRoot(wildcardSubject) : null;
                    if (zone) {
                        const bootstrapHost = `bun-bootstrap.${zone}`;
                        try {
                            await greenlockRuntime.get({ servername: bootstrapHost });
                        } catch (error) {
                            log.warn(`⚠️  Greenlock wildcard bootstrap failed for ${bootstrapHost}: ${error?.message || error}`);
                        }
                        pems = this._resolvePemsForServername(host);
                    }

                    return pems;
                };

                const ensureBunDefaultPems = async (primaryDomain) => {
                    let pems = await issueAndReloadPemsForServername(primaryDomain);

                    const needsWildcard = this.combineWildcardCerts
                        && this.wildcardZones.has(primaryDomain)
                        && this.dnsChallenge;

                    if (pems && needsWildcard && !certCoversName(pems.cert, `*.${primaryDomain}`)) {
                        log.warn(`⚠️  Existing cert for ${primaryDomain} lacks *.${primaryDomain} SAN — clearing stale cert for combined re-issuance`);
                        const certDir = path.join(this.greenlockStorePath, 'live', primaryDomain);
                        try { fs.rmSync(certDir, { recursive: true, force: true }); } catch {}
                        pems = null;
                    }

                    if (pems) return pems;

                    const certSubject = primaryDomain.startsWith('*.') ? wildcardRoot(primaryDomain) : primaryDomain;
                    log.warn(`⚠️  Bun: requesting ${needsWildcard ? 'combined wildcard' : ''} certificate for ${certSubject} via Greenlock before HTTPS bind`);
                    try {
                        await greenlockRuntime.get({ servername: certSubject });
                    } catch (error) {
                        log.error(`❌ Failed to obtain certificate for ${certSubject} under Bun:`, error?.message || error);
                    }

                    pems = this._resolvePemsForServername(primaryDomain);
                    if (pems) return pems;

                    throw new Error(
                        `Bun runtime could not load TLS certificate files for ${primaryDomain}. ` +
                        `Refusing to start HTTPS on port ${portNum} to avoid serving invalid TLS.`
                    );
                };

                if (portNum === this.defaultPort) {
                    const tlsOpts = { minVersion: this.tlsMinVersion, maxVersion: this.tlsMaxVersion };
                    let httpsServer;

                    if (isBunRuntime) {
                        const primaryDomain = Object.keys(portData.virtualServers)[0];
                        let defaultPems = await ensureBunDefaultPems(primaryDomain);
                        httpsServer = https.createServer({
                            ...tlsOpts,
                            key: defaultPems.key,
                            cert: defaultPems.cert,
                            SNICallback: (servername, callback) => {
                                issueAndReloadPemsForServername(servername)
                                    .then((pems) => {
                                        const selected = pems || defaultPems;
                                        callback(null, tls.createSecureContext({ key: selected.key, cert: selected.cert }));
                                    })
                                    .catch(callback);
                            }
                        }, dispatcher);
                        const reloadBunDefaultTls = async (servername, reason) => {
                            const nextPems = await issueAndReloadPemsForServername(servername);
                            if (!nextPems) return false;
                            defaultPems = nextPems;
                            if (typeof httpsServer.setSecureContext === 'function') {
                                try {
                                    httpsServer.setSecureContext({ key: defaultPems.key, cert: defaultPems.cert });
                                    log.info(`🔄 Bun TLS default certificate reloaded on port ${portNum} (${reason})`);
                                } catch (error) {
                                    log.warn(`⚠️  Failed to hot-reload Bun TLS context on port ${portNum}: ${error?.message || error}`);
                                }
                            }
                            return true;
                        };
                        bunTlsHotReloadHandlers.push(reloadBunDefaultTls);
                        log.warn(`⚠️  Bun runtime detected: using file-based TLS with SNI for ${primaryDomain} on port ${portNum}`);
                    } else {
                        httpsServer = glx.httpsServer(tlsOpts, dispatcher);
                    }

                    this.portServers[portNum] = httpsServer;
                    httpsServer.on('upgrade', upgradeHandler);

                    httpsServer.listen(portNum, this.hostname, () => {
                        log.info(`HTTPS server listening on port ${portNum}`);
                    });
                } else {
                    const httpsOptions = {
                        minVersion: this.tlsMinVersion,
                        maxVersion: this.tlsMaxVersion,
                        SNICallback: (servername, callback) => {
                            try {
                                const pems = this._resolvePemsForServername(servername);
                                if (pems) {
                                    callback(null, tls.createSecureContext({ key: pems.key, cert: pems.cert }));
                                } else {
                                    callback(new Error(`No certificate files available for ${servername}`));
                                }
                            } catch (error) {
                                callback(error);
                            }
                        }
                    };

                    const httpsServer = https.createServer(httpsOptions, dispatcher);
                    httpsServer.on('upgrade', upgradeHandler);

                    httpsServer.on('error', (error) => {
                        log.error(`HTTPS server error on port ${portNum}:`, error.message);
                    });

                    httpsServer.on('tlsClientError', (error) => {
                        if (!error.message.includes('http request')) {
                            log.error(`TLS error on port ${portNum}:`, error.message);
                        }
                    });

                    this.portServers[portNum] = httpsServer;

                    httpsServer.listen(portNum, this.hostname, (error) => {
                        if (error) {
                            log.error(`Failed to start HTTPS server on port ${portNum}:`, error.message);
                        } else {
                            log.info(`HTTPS server listening on port ${portNum}`);
                        }
                    });
                }
            }

            if (isBunRuntime && !this.combineWildcardCerts && this.wildcardZones.size > 0 && bunTlsHotReloadHandlers.length > 0) {
                const retryDelayMs = Number.isFinite(Number(process.env.ROSTER_BUN_WILDCARD_PREWARM_RETRY_MS))
                    ? Math.max(1000, Number(process.env.ROSTER_BUN_WILDCARD_PREWARM_RETRY_MS))
                    : 30000;
                const maxAttempts = Number.isFinite(Number(process.env.ROSTER_BUN_WILDCARD_PREWARM_MAX_ATTEMPTS))
                    ? Math.max(0, Number(process.env.ROSTER_BUN_WILDCARD_PREWARM_MAX_ATTEMPTS))
                    : 0;

                for (const zone of this.wildcardZones) {
                    const bootstrapHost = `bun-bootstrap.${zone}`;
                    const attemptPrewarm = async (attempt = 1) => {
                        try {
                            log.warn(`⚠️  Bun runtime detected: prewarming wildcard certificate via ${bootstrapHost} (attempt ${attempt})`);
                            let reloaded = false;
                            for (const reloadTls of bunTlsHotReloadHandlers) {
                                reloaded = (await reloadTls(bootstrapHost, `prewarm ${bootstrapHost} attempt ${attempt}`)) || reloaded;
                            }
                            if (!reloaded) {
                                throw new Error(`No certificate could be loaded for ${bootstrapHost}`);
                            }
                            log.info(`✅ Bun wildcard prewarm succeeded for ${zone} on attempt ${attempt}`);
                        } catch (error) {
                            log.warn(`⚠️  Bun wildcard prewarm failed for ${zone} (attempt ${attempt}): ${error?.message || error}`);
                            if (maxAttempts > 0 && attempt >= maxAttempts) {
                                log.warn(`⚠️  Bun wildcard prewarm stopped for ${zone} after ${attempt} attempts`);
                                return;
                            }
                            setTimeout(() => {
                                attemptPrewarm(attempt + 1).catch(() => {});
                            }, retryDelayMs);
                        }
                    };

                    attemptPrewarm().catch(() => {});
                }
            }
        });
    }
}

module.exports = Roster;
module.exports.isBunRuntime = isBunRuntime;
module.exports.wildcardRoot = wildcardRoot;
module.exports.hostMatchesWildcard = hostMatchesWildcard;
module.exports.wildcardSubjectForHost = wildcardSubjectForHost;
module.exports.buildCertLookupCandidates = buildCertLookupCandidates;
module.exports.certCoversName = certCoversName;