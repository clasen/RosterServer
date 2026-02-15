const Roster = require('../index.js');

// Example 1: Local mode
console.log('\n📍 EXAMPLE 1: Local Development Mode\n');
const localRoster = new Roster({ local: true });

localRoster.register('example.com', (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello from local!');
    };
});

localRoster.start().then(() => {
    console.log('Local URL:', localRoster.getUrl('example.com'));
    console.log('→ Returns: http://localhost:{port}\n');
});

// Example 2: Production mode (simulated, without actually starting)
console.log('📍 EXAMPLE 2: Production Mode (simulated)\n');
const prodRoster = new Roster({ 
    local: false,
    email: 'admin@example.com'
});

prodRoster.register('example.com', (httpsServer) => {
    return (req, res) => {
        res.writeHead(200);
        res.end('Hello from production!');
    };
});

// Don't actually start (would need real SSL), just show what URL would be
console.log('Production URL (without starting):', 'https://example.com');
console.log('→ Would return: https://example.com\n');

// Example 3: Production with custom port
console.log('📍 EXAMPLE 3: Production with Custom Port (simulated)\n');
const customPortRoster = new Roster({ 
    local: false,
    port: 8443,
    email: 'admin@example.com'
});

customPortRoster.register('api.example.com', (httpsServer) => {
    return (req, res) => {
        res.writeHead(200);
        res.end('API');
    };
});

console.log('Custom port URL (without starting):', 'https://api.example.com:8443');
console.log('→ Would return: https://api.example.com:8443\n');

console.log('✅ getUrl() adapts to the environment automatically!');
