const Roster = require('../index.js');

// Example 1: Get URL before creating instance (static method)
console.log('\n📍 Static URL Prediction (before server starts):');
console.log('example.com →', Roster.getLocalUrl('example.com'));
console.log('api.example.com →', Roster.getLocalUrl('api.example.com'));
console.log('test.example.com →', Roster.getLocalUrl('test.example.com'));

// Example 2: Get URL after registration (instance method)
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
    console.log('\n🚀 Server Started - Actual URLs:');
    console.log('example.com →', roster.getLocalUrl('example.com'));
    console.log('api.example.com →', roster.getLocalUrl('api.example.com'));
    
    // Test with www prefix (should return same URL)
    console.log('\n🔄 Testing www prefix handling:');
    console.log('www.example.com →', roster.getLocalUrl('www.example.com'));
    
    // Test non-existent domain
    console.log('\n❌ Testing non-existent domain:');
    console.log('nonexistent.com →', roster.getLocalUrl('nonexistent.com') || 'null (domain not registered)');
    
    console.log('\n✅ All domains running!');
});
