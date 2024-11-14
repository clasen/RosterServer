const fs = require('fs');
const path = require('path');
const Greenlock = require('greenlock-express');

class Roster {
    constructor(options = {}) {
        this.maintainerEmail = options.maintainerEmail || 'admin@example.com';
        this.wwwPath = options.wwwPath || path.join(__dirname, '..', '..', '..', 'www');
        this.greenlockConfigDir = options.greenlockConfigDir || path.join(__dirname, '..', '..', 'greenlock.d');
        this.staging = options.staging || false; // Set to true for testing
        this.domains = [];
        this.sites = {};
    }

    // Function to dynamically load domain applications
    loadSites() {
        fs.readdirSync(this.wwwPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .forEach((dirent) => {
                const domain = dirent.name;
                const domainPath = path.join(this.wwwPath, domain);
                
                // Check for different module file extensions
                const possibleIndexFiles = ['index.js', 'index.mjs', 'index.cjs'];
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
                    // Add the main domain and 'www' subdomain by default
                    const domainEntries = [domain, `www.${domain}`];
                    this.domains.push(...domainEntries);
                    domainEntries.forEach(d => {
                        this.sites[d] = siteApp;
                    });

                    console.log(`✅ Loaded site: ${domain} (using ${loadedFile})`);
                } else {
                    console.warn(`⚠️ No index file (js/mjs/cjs) found in ${domainPath}`);
                }
            });
    }

    generateConfigJson() {
        const configDir = this.greenlockConfigDir;
        const configPath = path.join(configDir, 'config.json');

        // Create the directory if it does not exist
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        const sitesConfig = [];
        const uniqueDomains = new Set();

        this.domains.forEach(domain => {
            const rootDomain = domain.replace(/^www\./, '');
            uniqueDomains.add(rootDomain);
        });

        // Read the existing config.json if it exists
        let existingConfig = {};
        if (fs.existsSync(configPath)) {
            // Read the current content
            const currentConfigContent = fs.readFileSync(configPath, 'utf8');
            existingConfig = JSON.parse(currentConfigContent);
        }

        uniqueDomains.forEach(domain => {
            const altnames = [domain];
            if ((domain.match(/\./g) || []).length < 2) {
                altnames.push(`www.${domain}`);
            }

            // Find the existing site to preserve renewAt
            let existingSite = null;
            if (existingConfig.sites) {
                existingSite = existingConfig.sites.find(site => site.subject === domain);
            }

            const siteConfig = {
                subject: domain,
                altnames: altnames
            };

            // Preserve renewAt if it exists
            if (existingSite && existingSite.renewAt) {
                siteConfig.renewAt = existingSite.renewAt;
            }

            sitesConfig.push(siteConfig);
        });

        const newConfig = {
            defaults: {
                store: {
                    module: "greenlock-store-fs",
                    basePath: this.greenlockConfigDir
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
                subscriberEmail: this.maintainerEmail
            },
            sites: sitesConfig
        };

        // Check if config.json already exists and compare
        if (fs.existsSync(configPath)) {
            // Read the current content
            const currentConfigContent = fs.readFileSync(configPath, 'utf8');
            const currentConfig = JSON.parse(currentConfigContent);

            // Compare the entire configurations
            const newConfigContent = JSON.stringify(newConfig, null, 2);
            const currentConfigContentFormatted = JSON.stringify(currentConfig, null, 2);

            if (newConfigContent === currentConfigContentFormatted) {
                console.log('ℹ️ Configuration has not changed. config.json will not be overwritten.');
                return; // Exit the function without overwriting
            } else {
                console.log('🔄 Configuration has changed. config.json will be updated.');
            }
        } else {
            console.log('🆕 config.json does not exist. A new one will be created.');
        }

        // Write the new config.json
        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
        console.log(`📁 config.json generated at ${configPath}`);
    }

    handleRequest(req, res) {
        const host = req.headers.host || '';
        
        // Handle www redirect
        if (host.startsWith('www.')) {
            const newHost = host.slice(4);
            res.writeHead(301, { Location: `https://${newHost}${req.url}` });
            res.end();
            return;
        }

        // Find and execute the appropriate site handler
        const siteApp = this.sites[host];
        if (siteApp) {
            siteApp(req, res);
        } else {
            res.writeHead(404);
            res.end('Site not found');
        }
    }

    initGreenlock() {
        Greenlock.init({
            packageRoot: __dirname,
            configDir: this.greenlockConfigDir,
            maintainerEmail: this.maintainerEmail,
            cluster: false,
            staging: this.staging,
            manager: { module: "@greenlock/manager" },
            approveDomains: (opts, certs, cb) => {
                // If certs is defined, we already have a certificate and are renewing it
                if (certs) {
                    opts.domains = certs.altnames;
                } else {
                    // If it's a new request, verify if the domain is in our list
                    if (this.domains.includes(opts.domain)) {
                        opts.email = this.maintainerEmail;
                        opts.agreeTos = true;
                        opts.domains = [opts.domain];
                    } else {
                        console.warn(`⚠️ Domain not approved: ${opts.domain}`);
                        return cb(new Error(`Domain not approved: ${opts.domain}`));
                    }
                }
                cb(null, { options: opts, certs });
            }
        }).ready((glx) => {
            // Setup HTTPS server
            const httpsServer = glx.httpsServer(null, (req, res) => {
                this.handleRequest(req, res);
            });

            httpsServer.listen(443, "0.0.0.0", () => {
                console.info("HTTPS Listening on", httpsServer.address());
            });

            // Setup HTTP server for ACME challenges
            const httpServer = glx.httpServer();

            httpServer.listen(80, "0.0.0.0", () => {
                console.info("HTTP Listening on", httpServer.address());
            });
        });
    }

    start() {
        this.loadSites();
        this.generateConfigJson();
        this.initGreenlock();
    }
}

module.exports = Roster;