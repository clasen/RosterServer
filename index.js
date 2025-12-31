const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { EventEmitter } = require('events');
const Greenlock = require('greenlock-express');
const log = require('lemonlog')('roster');

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
        res.end = function(...args) {
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
        this.domainServers = {}; // Store separate servers for each domain
        this.portServers = {}; // Store servers by port
        this.hostname = options.hostname || '0.0.0.0';
        this.filename = options.filename || 'index';

        const port = options.port === undefined ? 443 : options.port;
        if (port === 80 && !this.local) {
            throw new Error('⚠️  Port 80 is reserved for ACME challenge. Please use a different port.');
        }
        this.defaultPort = port;
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
                const domainEntries = [domain, `www.${domain}`];
                this.domains.push(...domainEntries);
                domainEntries.forEach(d => {
                    this.sites[d] = siteApp;
                });

                log.info(`(✔) Loaded site: https://${domain}`);
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

    register(domainString, requestHandler) {
        if (!domainString) {
            throw new Error('Domain is required');
        }
        if (typeof requestHandler !== 'function') {
            throw new Error('requestHandler must be a function');
        }

        const { domain, port } = this.parseDomainWithPort(domainString);
        
        const domainEntries = [domain];
        if ((domain.match(/\./g) || []).length < 2) {
            domainEntries.push(`www.${domain}`);
        }

        this.domains.push(...domainEntries);
        domainEntries.forEach(d => {
            // Store with port information
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

    createVirtualServer(domain) {
        return new VirtualServer(domain);
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
        const startPort = 3000;
        let currentPort = startPort;
        
        // Create a simple HTTP server for each domain with sequential ports
        for (const [hostKey, siteApp] of Object.entries(this.sites)) {
            const domain = hostKey.split(':')[0]; // Remove port if present
            
            // Skip www domains in local mode
            if (domain.startsWith('www.')) {
                continue;
            }
            
            const port = currentPort; // Capture current port value
            
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
            
            currentPort++;
        }
        
        log.info(`(✔) Started ${currentPort - startPort} sites in local mode`);
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

        const greenlock = Greenlock.init({
            packageRoot: __dirname,
            configDir: this.greenlockStorePath,
            maintainerEmail: this.email,
            cluster: this.cluster,
            staging: this.staging
        });

        return greenlock.ready(glx => {
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
                    
                    // Create completely isolated virtual server
                    const virtualServer = this.createVirtualServer(domain);
                    sitesByPort[port].virtualServers[domain] = virtualServer;
                    this.domainServers[domain] = virtualServer;
                    
                    // Initialize app with virtual server
                    const appHandler = siteApp(virtualServer);
                    sitesByPort[port].appHandlers[domain] = appHandler;
                    sitesByPort[port].appHandlers[`www.${domain}`] = appHandler;
                }
            }

            // Create dispatcher for each port
            const createDispatcher = (portData) => {
                return (req, res) => {
                    const host = req.headers.host || '';
                    
                    // Remove port from host header if present (e.g., "domain.com:8080" -> "domain.com")
                    const hostWithoutPort = host.split(':')[0];
                    const domain = hostWithoutPort.startsWith('www.') ? hostWithoutPort.slice(4) : hostWithoutPort;
                    
                    // Handle www redirects
                    if (hostWithoutPort.startsWith('www.')) {
                        res.writeHead(301, { Location: `https://${domain}${req.url}` });
                        res.end();
                        return;
                    }

                    const virtualServer = portData.virtualServers[domain];
                    const appHandler = portData.appHandlers[domain];
                    
                    if (virtualServer && virtualServer.requestListeners.length > 0) {
                        // Set fallback handler on virtual server for non-Socket.IO requests
                        virtualServer.fallbackHandler = appHandler;
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
            };

            httpServer.listen(80, this.hostname, () => {
                log.info('HTTP server listening on port 80');
            });

            // Create upgrade handler for WebSocket connections
            const createUpgradeHandler = (portData) => {
                return (req, socket, head) => {
                    const host = req.headers.host || '';
                    const hostWithoutPort = host.split(':')[0];
                    const domain = hostWithoutPort.startsWith('www.') ? hostWithoutPort.slice(4) : hostWithoutPort;
                    
                    const virtualServer = portData.virtualServers[domain];
                    
                    if (virtualServer) {
                        virtualServer.processUpgrade(req, socket, head);
                    } else {
                        // No virtual server found, destroy the socket
                        socket.destroy();
                    }
                };
            };

            // Handle different port types
            for (const [port, portData] of Object.entries(sitesByPort)) {
                const portNum = parseInt(port);
                const dispatcher = createDispatcher(portData);
                const upgradeHandler = createUpgradeHandler(portData);
                
                if (portNum === this.defaultPort) {
                    // Use Greenlock for default port (443) with SSL
                    const httpsServer = glx.httpsServer(null, dispatcher);
                    this.portServers[portNum] = httpsServer;
                    
                    // Handle WebSocket upgrade events
                    httpsServer.on('upgrade', upgradeHandler);
                    
                    httpsServer.listen(portNum, this.hostname, () => {
                        log.info(`HTTPS server listening on port ${portNum}`);
                    });
                } else {
                    // Create HTTPS server for custom ports using Greenlock certificates
                    const httpsOptions = {
                        // SNI callback to get certificates dynamically
                        SNICallback: (domain, callback) => {
                            try {
                                const certPath = path.join(this.greenlockStorePath, 'live', domain);
                                const keyPath = path.join(certPath, 'privkey.pem');
                                const certFilePath = path.join(certPath, 'cert.pem');
                                const chainPath = path.join(certPath, 'chain.pem');
                                
                                if (fs.existsSync(keyPath) && fs.existsSync(certFilePath) && fs.existsSync(chainPath)) {
                                    const key = fs.readFileSync(keyPath, 'utf8');
                                    const cert = fs.readFileSync(certFilePath, 'utf8');
                                    const chain = fs.readFileSync(chainPath, 'utf8');
                                    
                                    callback(null, tls.createSecureContext({
                                        key: key,
                                        cert: cert + chain
                                    }));
                                } else {
                                    callback(new Error(`No certificate files available for ${domain}`));
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
        });
    }
}

module.exports = Roster;