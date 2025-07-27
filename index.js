const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Greenlock = require('greenlock-express');

// Virtual Server that completely isolates applications
class VirtualServer extends EventEmitter {
    constructor(domain) {
        super();
        this.domain = domain;
        this.requestListeners = [];
        
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
        }
        return super.listeners(event);
    }
    
    removeListener(event, listener) {
        if (event === 'request') {
            const index = this.requestListeners.indexOf(listener);
            if (index !== -1) {
                this.requestListeners.splice(index, 1);
            }
        }
        return super.removeListener(event, listener);
    }
    
    removeAllListeners(event) {
        if (event === 'request') {
            this.requestListeners = [];
        }
        return super.removeAllListeners(event);
    }
    
    // Simulate other http.Server methods
    listen() { this.listening = true; return this; }
    close() { this.listening = false; return this; }
    setTimeout() { return this; }
    
    // Process request with this virtual server's listeners
    processRequest(req, res) {
        for (const listener of this.requestListeners) {
            listener(req, res);
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
        this.domains = [];
        this.sites = {};
        this.domainServers = {}; // Store separate servers for each domain
        this.hostname = options.hostname || '0.0.0.0';
        this.filename = options.filename || 'index';

        const port = options.port === undefined ? 443 : options.port;
        if (port === 80) {
            throw new Error('⚠️  Port 80 is reserved for ACME challenge. Please use a different port.');
        }
        this.port = port;
    }

    async loadSites() {
        // Check if wwwPath exists
        if (!fs.existsSync(this.wwwPath)) {
            console.warn(`⚠️  WWW path does not exist: ${this.wwwPath}`);
            return;
        }

        const sites = fs.readdirSync(this.wwwPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory());

        for (const dirent of sites) {
            const domain = dirent.name;
            const domainPath = path.join(this.wwwPath, domain);

            const possibleIndexFiles = ['js', 'mjs', 'cjs'].map(ext => `${this.filename}.${ext}`);
            let siteApp;
            let loadedFile;

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
                        loadedFile = indexFile;
                        break;
                    } catch (err) {
                        console.warn(`⚠️  Error loading ${indexPath}:`, err);
                    }
                }
            }

            if (siteApp) {
                const domainEntries = [domain, `www.${domain}`];
                this.domains.push(...domainEntries);
                domainEntries.forEach(d => {
                    this.sites[d] = siteApp;
                });

                console.log(`✅  Loaded site: ${domain} (using ${loadedFile})`);
            } else {
                console.warn(`⚠️  No index file (js/mjs/cjs) found in ${domainPath}`);
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
            const rootDomain = domain.replace(/^www\./, '');
            uniqueDomains.add(rootDomain);
        });

        let existingConfig = {};
        if (fs.existsSync(configPath)) {
            const currentConfigContent = fs.readFileSync(configPath, 'utf8');
            existingConfig = JSON.parse(currentConfigContent);
        }

        uniqueDomains.forEach(domain => {
            const altnames = [domain];
            if ((domain.match(/\./g) || []).length < 2) {
                altnames.push(`www.${domain}`);
            }

            let existingSite = null;
            if (existingConfig.sites) {
                existingSite = existingConfig.sites.find(site => site.subject === domain);
            }

            const siteConfig = {
                subject: domain,
                altnames: altnames
            };

            if (existingSite && existingSite.renewAt) {
                siteConfig.renewAt = existingSite.renewAt;
            }

            sitesConfig.push(siteConfig);
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
                console.log('ℹ️  Configuration has not changed. config.json will not be overwritten.');
                return;
            }
            console.log('🔄  Configuration has changed. config.json will be updated.');
        } else {
            console.log('🆕  config.json does not exist. A new one will be created.');
        }

        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
        console.log(`📁  config.json generated at ${configPath}`);
    }

    handleRequest(req, res) {
        const host = req.headers.host || '';

        if (host.startsWith('www.')) {
            const newHost = host.slice(4);
            res.writeHead(301, { Location: `https://${newHost}${req.url}` });
            res.end();
            return;
        }

        const siteApp = this.sites[host];
        if (siteApp) {
            siteApp(req, res);
        } else {
            res.writeHead(404);
            res.end('Site not found');
        }
    }

    register(domain, requestHandler) {
        if (!domain) {
            throw new Error('Domain is required');
        }
        if (typeof requestHandler !== 'function') {
            throw new Error('requestHandler must be a function');
        }

        const domainEntries = [domain];
        if ((domain.match(/\./g) || []).length < 2) {
            domainEntries.push(`www.${domain}`);
        }

        this.domains.push(...domainEntries);
        domainEntries.forEach(d => {
            this.sites[d] = requestHandler;
        });

        console.log(`✅  Manually registered site: ${domain}`);
        return this;
    }

    createVirtualServer(domain) {
        return new VirtualServer(domain);
    }

    async start() {
        await this.loadSites();
        this.generateConfigJson();

        const greenlock = Greenlock.init({
            packageRoot: __dirname,
            configDir: this.greenlockStorePath,
            maintainerEmail: this.email,
            cluster: this.cluster,
            staging: this.staging
        });

        return greenlock.ready(glx => {
            const httpServer = glx.httpServer();
            const virtualServers = {};
            const appHandlers = {};
            
            // Create virtual servers and initialize applications
            for (const [host, siteApp] of Object.entries(this.sites)) {
                if (!host.startsWith('www.')) {
                    // Create completely isolated virtual server
                    const virtualServer = this.createVirtualServer(host);
                    virtualServers[host] = virtualServer;
                    this.domainServers[host] = virtualServer;
                    
                    // Initialize app with virtual server
                    const appHandler = siteApp(virtualServer);
                    appHandlers[host] = appHandler;
                    appHandlers[`www.${host}`] = appHandler;
                }
            }

            // Central dispatcher - the ONLY real listener
            const centralDispatcher = (req, res) => {
                const host = req.headers.host || '';
                
                // Handle www redirects
                if (host.startsWith('www.')) {
                    const newHost = host.slice(4);
                    res.writeHead(301, { Location: `https://${newHost}${req.url}` });
                    res.end();
                    return;
                }

                const virtualServer = virtualServers[host];
                const appHandler = appHandlers[host];
                
                if (virtualServer && virtualServer.requestListeners.length > 0) {
                    // App registered listeners on virtual server - use them
                    virtualServer.processRequest(req, res);
                } else if (appHandler) {
                    // App returned a handler function - use it
                    appHandler(req, res);
                } else {
                    res.writeHead(404);
                    res.end('Site not found');
                }
            };

            // Single HTTPS server with central dispatcher
            const mainHttpsServer = glx.httpsServer(null, centralDispatcher);

            // Start servers
            httpServer.listen(80, this.hostname, () => {
                console.log('ℹ️  HTTP server listening on port 80');
            });

            mainHttpsServer.listen(this.port, this.hostname, () => {
                console.log('ℹ️  HTTPS server listening on port ' + this.port);
            });
        });
    }
}

module.exports = Roster;