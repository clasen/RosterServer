const fs = require('fs');
const path = require('path');
const Greenlock = require('greenlock-express');

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
        this.hostname = options.hostname || '0.0.0.0';
        this.filename = options.filename || 'index';

        const port = options.port || 443;
        if (port === 80) {
            throw new Error('⚠️  Port 80 is reserved for ACME challenge. Please use a different port.');
        }
        this.port = port;

        this.loadSites();
    }

    loadSites() {
        // Check if wwwPath exists
        if (!fs.existsSync(this.wwwPath)) {
            console.warn(`⚠️  WWW path does not exist: ${this.wwwPath}`);
            return;
        }

        fs.readdirSync(this.wwwPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .forEach((dirent) => {
                const domain = dirent.name;
                const domainPath = path.join(this.wwwPath, domain);

                const possibleIndexFiles = ['js', 'mjs', 'cjs'].map(ext => `${this.filename}.${ext}`);
                let siteApp;
                let loadedFile;

                for (const indexFile of possibleIndexFiles) {
                    const indexPath = path.join(domainPath, indexFile);
                    if (fs.existsSync(indexPath)) {
                        siteApp = require(indexPath);
                        loadedFile = indexFile;
                        break;
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
            });
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

    registerSite(domain, requestHandler) {
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
    }

    start() {
        this.generateConfigJson();

        const greenlock = Greenlock.init({
            packageRoot: __dirname,
            configDir: this.greenlockStorePath,
            maintainerEmail: this.email,
            cluster: this.cluster,
            staging: this.staging
        });

        const app = (req, res) => {
            this.handleRequest(req, res);
        };

        greenlock.ready(glx => {
            // Obtener los servidores sin iniciarlos
            const httpsServer = glx.httpsServer(null, app);
            const httpServer = glx.httpServer();

            for (const [host, siteApp] of Object.entries(this.sites)) {
                if (!host.startsWith('www.')) {
                    const appInstance = siteApp(httpsServer);
                    this.sites[host] = appInstance;
                    this.sites[`www.${host}`] = appInstance;
                    console.log(`🔧 Initialized server for ${host}`);
                }
            }

            httpServer.listen(80, this.hostname, () => {
                console.log('ℹ️  HTTP server listening on port 80');
            });

            httpsServer.listen(this.port, this.hostname, () => {
                console.log('ℹ️  HTTPS server listening on port ' + this.port);
            });
        });
    }
}

module.exports = Roster;