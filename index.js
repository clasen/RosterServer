const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const Greenlock = require('./vendor/greenlock-express/greenlock-express.js');
const GreenlockShim = require('./vendor/greenlock-express/greenlock-shim.js');
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
        this.hostname = options.hostname || '0.0.0.0';
        this.filename = options.filename || 'index';
        this.minLocalPort = options.minLocalPort || 4000;
        this.maxLocalPort = options.maxLocalPort || 9999;
        this.tlsMinVersion = options.tlsMinVersion ?? 'TLSv1.2';
        this.tlsMaxVersion = options.tlsMaxVersion ?? 'TLSv1.3';
        this.disableWildcard = options.disableWildcard !== undefined
            ? parseBooleanFlag(options.disableWildcard, false)
            : parseBooleanFlag(process.env.ROSTER_DISABLE_WILDCARD, false);
        const combineDefault = false;
        this.combineWildcardCerts = options.combineWildcardCerts !== undefined
            ? parseBooleanFlag(options.combineWildcardCerts, combineDefault)
            : parseBooleanFlag(process.env.ROSTER_COMBINE_WILDCARD_CERTS, combineDefault);
        if (isBunRuntime && this.combineWildcardCerts) {
            log.info('Bun runtime detected: combined wildcard certificates enabled (SNI bypass)');
        }

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

            const possibleIndexFiles = ['js', 'mjs', 'cjs'].map(ext => `${this.filename}.${ext}`);
            let siteApp;

            for (const indexFile of possibleIndexFiles) {
                const indexPath = path.join(domainPath, indexFile);
                if (fs.existsSync(indexPath)) {
                    try {
                        // Try dynamic import first
                        siteApp = await import(indexPath).catch(() => {
                            // Fallback to require for CommonJS modules
                            return require(indexPath);
                        });
                        // Handle default exports
                        siteApp = siteApp.default || siteApp;
                        break;
                    } catch (err) {
                        log.warn(`⚠️  Error loading ${indexPath}:`, err);
                    }
                }
            }

            if (siteApp) {
                if (domain.startsWith('*.')) {
                    if (this.disableWildcard) {
                        log.warn(`⚠️  Wildcard site skipped (disableWildcard enabled): ${domain}`);
                        continue;
                    }
                    // Wildcard site: one handler for all subdomains (e.g. *.example.com)
                    this.domains.push(domain);
                    this.sites[domain] = siteApp;
                    const root = wildcardRoot(domain);
                    if (root) this.wildcardZones.add(root);
                    log.info(`(✔) Loaded wildcard site: https://${domain}`);
                } else {
                    const domainEntries = [domain, `www.${domain}`];
                    this.domains.push(...domainEntries);
                    domainEntries.forEach(d => {
                        this.sites[d] = siteApp;
                    });
                    log.info(`(✔) Loaded site: https://${domain}`);
                }
            } else {
                log.warn(`⚠️  No index file (js/mjs/cjs) found in ${domainPath}`);
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
        const cleanDomain = domain.startsWith('www.') ? domain.slice(4) : domain;

        const exactMatch = this.sites[cleanDomain] || this.sites[`www.${cleanDomain}`];
        const resolved = exactMatch ? { handler: exactMatch, siteKey: cleanDomain } : this.getHandlerAndKeyForHost(cleanDomain);
        if (!resolved) return null;

        if (this.local) {
            const pattern = resolved.siteKey.split(':')[0];
            if (this.domainPorts && this.domainPorts[pattern] !== undefined) {
                return `http://localhost:${this.domainPorts[pattern]}`;
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

    // Start server in local mode with HTTP - simplified version
    startLocalMode() {
        // Store mapping of domain to port for later retrieval
        this.domainPorts = {};

        // Create a simple HTTP server for each domain with CRC32-based ports
        for (const [hostKey, siteApp] of Object.entries(this.sites)) {
            const domain = hostKey.split(':')[0]; // Remove port if present

            // Skip www domains in local mode
            if (domain.startsWith('www.')) {
                continue;
            }

            // Calculate deterministic port based on domain CRC32, with collision detection
            const port = this.assignPortToDomain(domain);

            // Store domain → port mapping
            this.domainPorts[domain] = port;

            // Create virtual server for the domain
            const virtualServer = this.createVirtualServer(domain);
            this.domainServers[domain] = virtualServer;

            // Initialize app with virtual server
            const appHandler = siteApp(virtualServer);

            // Create simple dispatcher for this domain
            const dispatcher = (req, res) => {
                // Set fallback handler on virtual server for non-Socket.IO requests
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

            // Create HTTP server for this domain
            const httpServer = http.createServer(dispatcher);
            this.portServers[port] = httpServer;

            // Handle WebSocket upgrade events
            httpServer.on('upgrade', (req, socket, head) => {
                virtualServer.processUpgrade(req, socket, head);
            });

            httpServer.listen(port, 'localhost', () => {
                log.info(`🌐 ${domain} → http://localhost:${port}`);
            });

            httpServer.on('error', (error) => {
                log.error(`❌ Error on port ${port} for ${domain}:`, error.message);
            });
        }

        log.info(`(✔) Started ${Object.keys(this.portServers).length} sites in local mode`);
        return Promise.resolve();
    }

    async start() {
        await this.loadSites();

        // Skip Greenlock configuration generation in local mode
        if (!this.local) {
            this.generateConfigJson();
        }

        // Handle local mode with simple HTTP server
        if (this.local) {
            return this.startLocalMode();
        }

        const greenlockOptions = {
            packageRoot: __dirname,
            configDir: this.greenlockStorePath,
            maintainerEmail: this.email,
            cluster: this.cluster,
            staging: this.staging,
            notify: (event, details) => {
                const msg = typeof details === 'string' ? details : (details?.message ?? JSON.stringify(details));
                // Suppress known benign warnings from ACME when using acme-dns-01-cli
                if (event === 'warning' && typeof msg === 'string') {
                    if (/acme-dns-01-cli.*(incorrect function signatures|deprecated use of callbacks)/i.test(msg)) return;
                    if (/dns-01 challenge plugin should have zones/i.test(msg)) return;
                }
                if (event === 'error') log.error(msg);
                else if (event === 'warning') log.warn(msg);
                else log.info(msg);
            }
        };
        // Keep a direct greenlock runtime handle so we can call get() explicitly under Bun
        // before binding :443, avoiding invalid non-TLS responses on startup.
        const greenlockRuntime = GreenlockShim.create(greenlockOptions);
        const greenlock = Greenlock.init({
            ...greenlockOptions,
            greenlock: greenlockRuntime
        });

        return greenlock.ready(async glx => {
            const httpServer = glx.httpServer();

            // Group sites by port
            const sitesByPort = {};
            for (const [hostKey, siteApp] of Object.entries(this.sites)) {
                if (!hostKey.startsWith('www.')) {
                    const { domain, port } = this.parseDomainWithPort(hostKey);
                    if (!sitesByPort[port]) {
                        sitesByPort[port] = {
                            virtualServers: {},
                            appHandlers: {}
                        };
                    }

                    const virtualServer = this.createVirtualServer(domain);
                    sitesByPort[port].virtualServers[domain] = virtualServer;
                    this.domainServers[domain] = virtualServer;

                    const appHandler = siteApp(virtualServer);
                    sitesByPort[port].appHandlers[domain] = appHandler;
                    if (!domain.startsWith('*.')) {
                        sitesByPort[port].appHandlers[`www.${domain}`] = appHandler;
                    }
                }
            }

            const bunTlsHotReloadHandlers = [];

            // Create dispatcher for each port
            const createDispatcher = (portData) => {
                return (req, res) => {
                    const host = req.headers.host || '';

                    const hostWithoutPort = host.split(':')[0].toLowerCase();
                    const domain = hostWithoutPort.startsWith('www.') ? hostWithoutPort.slice(4) : hostWithoutPort;

                    if (hostWithoutPort.startsWith('www.')) {
                        res.writeHead(301, { Location: `https://${domain}${req.url}` });
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
            };

            httpServer.listen(80, this.hostname, () => {
                log.info('HTTP server listening on port 80');
            });

            const createUpgradeHandler = (portData) => {
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
            };

            // Handle different port types
            for (const [port, portData] of Object.entries(sitesByPort)) {
                const portNum = parseInt(port);
                const dispatcher = createDispatcher(portData);
                const upgradeHandler = createUpgradeHandler(portData);
                const greenlockStorePath = this.greenlockStorePath;
                const normalizeHostInput = (value) => {
                    if (typeof value === 'string') return value;
                    if (!value || typeof value !== 'object') return '';
                    if (typeof value.servername === 'string') return value.servername;
                    if (typeof value.hostname === 'string') return value.hostname;
                    if (typeof value.subject === 'string') return value.subject;
                    return '';
                };
                const loadCert = (subjectDir) => {
                    const normalizedSubject = normalizeHostInput(subjectDir).trim().toLowerCase();
                    if (!normalizedSubject) return null;
                    const certPath = path.join(greenlockStorePath, 'live', normalizedSubject);
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
                };
                const resolvePemsForServername = (servername) => {
                    const host = normalizeHostInput(servername).trim().toLowerCase();
                    if (!host) return null;
                    const candidates = buildCertLookupCandidates(host);
                    for (const candidate of candidates) {
                        const pems = loadCert(candidate);
                        if (pems) return pems;
                    }
                    return null;
                };
                const issueAndReloadPemsForServername = async (servername) => {
                    const host = normalizeHostInput(servername).trim().toLowerCase();
                    if (!host) return null;

                    let pems = resolvePemsForServername(host);
                    if (pems) return pems;

                    try {
                        await greenlockRuntime.get({ servername: host });
                    } catch (error) {
                        log.warn(`⚠️  Greenlock issuance failed for ${host}: ${error?.message || error}`);
                    }

                    pems = resolvePemsForServername(host);
                    if (pems) return pems;

                    // For wildcard zones, try a valid subdomain bootstrap host so Greenlock can
                    // resolve the wildcard site without relying on invalid "*.domain" servername input.
                    const wildcardSubject = wildcardSubjectForHost(host);
                    const zone = wildcardSubject ? wildcardRoot(wildcardSubject) : null;
                    if (zone) {
                        const bootstrapHost = `bun-bootstrap.${zone}`;
                        try {
                            await greenlockRuntime.get({ servername: bootstrapHost });
                        } catch (error) {
                            log.warn(`⚠️  Greenlock wildcard bootstrap failed for ${bootstrapHost}: ${error?.message || error}`);
                        }
                        pems = resolvePemsForServername(host);
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
                        const certDir = path.join(greenlockStorePath, 'live', primaryDomain);
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

                    pems = resolvePemsForServername(primaryDomain);
                    if (pems) return pems;

                    throw new Error(
                        `Bun runtime could not load TLS certificate files for ${primaryDomain}. ` +
                        `Refusing to start HTTPS on port ${portNum} to avoid serving invalid TLS.`
                    );
                };

                if (portNum === this.defaultPort) {
                    // Bun has known gaps around SNICallback compatibility.
                    // Fallback to static cert loading for the primary domain on default HTTPS port.
                    const tlsOpts = { minVersion: this.tlsMinVersion, maxVersion: this.tlsMaxVersion };
                    let httpsServer;

                    if (isBunRuntime) {
                        const primaryDomain = Object.keys(portData.virtualServers)[0];
                        // Under Bun, avoid glx.httpsServer fallback (may serve invalid TLS on :443).
                        // Require concrete PEM files and create native https server directly.
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

                    // Handle WebSocket upgrade events
                    httpsServer.on('upgrade', upgradeHandler);

                    httpsServer.listen(portNum, this.hostname, () => {
                        log.info(`HTTPS server listening on port ${portNum}`);
                    });
                } else {
                    // Create HTTPS server for custom ports using Greenlock certificates
                    const httpsOptions = {
                        minVersion: this.tlsMinVersion,
                        maxVersion: this.tlsMaxVersion,
                        SNICallback: (servername, callback) => {
                            try {
                                const pems = resolvePemsForServername(servername);
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

                    // Handle WebSocket upgrade events
                    httpsServer.on('upgrade', upgradeHandler);

                    httpsServer.on('error', (error) => {
                        log.error(`HTTPS server error on port ${portNum}:`, error.message);
                    });

                    httpsServer.on('tlsClientError', (error) => {
                        // Suppress HTTP request errors to avoid log spam
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
                    : 0; // 0 = retry forever

                for (const zone of this.wildcardZones) {
                    const bootstrapHost = `bun-bootstrap.${zone}`;
                    const attemptPrewarm = async (attempt = 1) => {
                        try {
                            log.warn(`⚠️  Bun runtime detected: prewarming wildcard certificate via ${bootstrapHost} (attempt ${attempt})`);
                            let reloaded = false;
                            for (const reloadTls of bunTlsHotReloadHandlers) {
                                // Trigger issuance + immediately hot-reload default TLS context when ready.
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

                    // Background prewarm + retries so HTTPS startup is not blocked by DNS propagation timing.
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