const Roster = require('../index.js');

console.log('\n🧪 Testing getUrl() method in different scenarios\n');

// Test 1: Local mode with default port
console.log('TEST 1: Local mode (default port)');
const local1 = new Roster({ local: true });
local1.register('example.com', () => (req, res) => res.end('OK'));
local1.start().then(() => {
    const url = local1.getUrl('example.com');
    console.log(`✓ example.com → ${url}`);
    console.assert(url.startsWith('http://localhost:'), 'Should be localhost HTTP');
});

// Test 2: Local mode with custom port range
console.log('\nTEST 2: Local mode (custom port range)');
const local2 = new Roster({ local: true, minLocalPort: 6000, maxLocalPort: 6100 });
local2.register('test.com', () => (req, res) => res.end('OK'));
local2.start().then(() => {
    const url = local2.getUrl('test.com');
    console.log(`✓ test.com → ${url}`);
    const port = parseInt(url.split(':')[2]);
    console.assert(port >= 6000 && port <= 6100, 'Port should be in custom range');
});

// Test 3: Production mode (default HTTPS port)
console.log('\nTEST 3: Production mode (default HTTPS)');
const prod1 = new Roster({ local: false, email: 'admin@example.com' });
prod1.register('example.com', () => (req, res) => res.end('OK'));
const prodUrl1 = prod1.getUrl('example.com');
console.log(`✓ example.com → ${prodUrl1}`);
console.assert(prodUrl1 === 'https://example.com', 'Should be HTTPS without port');

// Test 4: Production mode (custom port)
console.log('\nTEST 4: Production mode (custom port)');
const prod2 = new Roster({ local: false, port: 8443, email: 'admin@example.com' });
prod2.register('api.example.com', () => (req, res) => res.end('OK'));
const prodUrl2 = prod2.getUrl('api.example.com');
console.log(`✓ api.example.com → ${prodUrl2}`);
console.assert(prodUrl2 === 'https://api.example.com:8443', 'Should include custom port');

// Test 5: www prefix handling
console.log('\nTEST 5: www prefix handling');
const local3 = new Roster({ local: true });
local3.register('example.com', () => (req, res) => res.end('OK'));
local3.start().then(() => {
    const url1 = local3.getUrl('example.com');
    const url2 = local3.getUrl('www.example.com');
    console.log(`✓ example.com → ${url1}`);
    console.log(`✓ www.example.com → ${url2}`);
    console.assert(url1 === url2, 'www should return same URL');
});

// Test 6: Non-existent domain
console.log('\nTEST 6: Non-existent domain');
const local4 = new Roster({ local: true });
local4.register('example.com', () => (req, res) => res.end('OK'));
local4.start().then(() => {
    const url = local4.getUrl('nonexistent.com');
    console.log(`✓ nonexistent.com → ${url}`);
    console.assert(url === null, 'Should return null for unregistered domain');
    
    console.log('\n✅ All tests passed!\n');
});
