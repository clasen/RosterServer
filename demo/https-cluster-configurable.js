const cluster = require('cluster');
const os = require('os');
const path = require('path');
const Roster = require('../index.js');

// Change these values to your target domain and HTTPS port.
const CONFIG = {
    domain: 'example.com',
    httpsPort: 4336,
    workers: Math.max(1, Math.min(2, os.cpus().length)),
    certificateManagerHttpsPort: 0, // 0 = ephemeral, manager does not serve public traffic
    wwwPath: path.join(__dirname, 'www'),
    greenlockStorePath: path.join(__dirname, '..', 'greenlock.d'),
    email: 'mclasen@example.com',
    staging: false
};

function createRoster({ isCertificateManager }) {
    const roster = new Roster({
        local: false,
        email: CONFIG.email,
        staging: CONFIG.staging,
        wwwPath: CONFIG.wwwPath,
        greenlockStorePath: CONFIG.greenlockStorePath,
        autoCertificates: isCertificateManager,
        // Certificate manager can bind an ephemeral HTTPS port; workers serve real traffic.
        port: isCertificateManager ? CONFIG.certificateManagerHttpsPort : 443
    });
    return roster;
}

async function startWorker() {
    const roster = createRoster({ isCertificateManager: false });

    // Domain is configured from CONFIG (single source of truth).
    roster.register(CONFIG.domain, () => {
        return (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(`HTTPS cluster response from worker ${process.pid} for ${CONFIG.domain}`);
        };
    });

    await roster.init();
    const server = await roster.createServingHttpsServer({
        servername: CONFIG.domain
    });

    server.listen(CONFIG.httpsPort, () => {
        console.log(`[worker ${process.pid}] listening on https://0.0.0.0:${CONFIG.httpsPort} for domain ${CONFIG.domain}`);
    });
}

async function startPrimary() {
    console.log(`\n[primary ${process.pid}] starting ${CONFIG.workers} workers`);
    console.log(`domain=${CONFIG.domain} port=${CONFIG.httpsPort}`);
    console.log(`wwwPath=${CONFIG.wwwPath}`);
    console.log(`greenlockStorePath=${CONFIG.greenlockStorePath}\n`);
    console.log('[primary] cert lifecycle managed by roster-server\n');

    // Primary is the single certificate manager to avoid ACME race conditions.
    // It starts Roster standalone lifecycle so ACME http-01 challenge server (:80) is active.
    const certificateManager = createRoster({ isCertificateManager: true });
    certificateManager.register(CONFIG.domain, () => {
        return (req, res) => {
            res.writeHead(200);
            res.end('certificate-manager');
        };
    });
    await certificateManager.start();
    await certificateManager.ensureCertificate(CONFIG.domain);
    const subject = CONFIG.domain;
    console.log(`[primary] certificate ready for ${CONFIG.domain} (subject=${subject})\n`);

    for (let i = 0; i < CONFIG.workers; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker) => {
        console.log(`[primary] worker ${worker.process.pid} exited, restarting...`);
        cluster.fork();
    });
}

if (cluster.isPrimary) {
    startPrimary().catch((err) => {
        console.error(`[primary ${process.pid}] startup failed`, err);
        process.exit(1);
    });
} else {
    startWorker().catch((err) => {
        console.error(`[worker ${process.pid}] startup failed`, err);
        process.exit(1);
    });
}

