/**
 * Wildcard DNS demo: one handler for all subdomains (*.example.com)
 *
 * Run from repo root: node demo/wildcard-example.js
 * Then open the printed URL (or use curl with Host header) to see the wildcard response.
 * Any subdomain (api.example.com, app.example.com, foo.example.com) uses the same handler.
 */
const Roster = require('../index.js');
const path = require('path');
const { wildcardRoot } = require('../index.js');

const roster = new Roster({
    local: true,
    wwwPath: path.join(__dirname, 'www'),
});

roster.start().then(() => {
    const wildcardPattern = roster.domains.find((d) => d.startsWith('*.'));
    const subdomain = wildcardPattern ? 'api.' + wildcardRoot(wildcardPattern) : 'api.example.com';
    const wildcardUrl = roster.getUrl(subdomain);

    console.log('\n🌐 Wildcard demo');
    console.log('   Loaded:', wildcardPattern ? `https://${wildcardPattern}` : '(none)');
    console.log('   Any subdomain uses the same handler.\n');
    console.log('   Try:', wildcardUrl || '(no wildcard site in www path)');
    if (wildcardUrl) {
        const host = wildcardPattern ? 'api.' + wildcardRoot(wildcardPattern) : 'api.example.com';
        console.log('   Or:  curl -H "Host: ' + host + '"', wildcardUrl);
    }
    console.log('');
});
