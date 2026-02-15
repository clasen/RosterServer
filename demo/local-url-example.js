const Roster = require('../index.js');

// Example: Get URL after registration (adapts to environment)
console.log('\n🔧 Creating local development server...\n');

const roster = new Roster({ local: true });

roster.register('example.com', (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello from example.com!');
    };
});

roster.register('api.example.com', (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'API endpoint' }));
    };
});

roster.start().then(() => {
    console.log('🚀 Server Started - URLs (based on environment):');
    console.log('example.com →', roster.getUrl('example.com'));
    console.log('api.example.com →', roster.getUrl('api.example.com'));
    
    // Test with www prefix (should return same URL)
    console.log('\n🔄 Testing www prefix handling:');
    console.log('www.example.com →', roster.getUrl('www.example.com'));
    
    // Test non-existent domain
    console.log('\n❌ Testing non-existent domain:');
    console.log('nonexistent.com →', roster.getUrl('nonexistent.com') || 'null (domain not registered)');
    
    console.log('\n✅ All domains running!');
});
