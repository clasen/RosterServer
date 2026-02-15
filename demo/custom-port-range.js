const Roster = require('../index.js');

// Example with custom port range
const roster = new Roster({ 
    local: true,
    minLocalPort: 5000,  // Custom minimum port
    maxLocalPort: 5100   // Custom maximum port
});

console.log('\n📍 Static URL Prediction with custom range (5000-5100):');
console.log('example.com →', Roster.getLocalUrl('example.com', { 
    minLocalPort: 5000, 
    maxLocalPort: 5100 
}));
console.log('api.example.com →', Roster.getLocalUrl('api.example.com', { 
    minLocalPort: 5000, 
    maxLocalPort: 5100 
}));

roster.register('example.com', (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello from example.com with custom port range!');
    };
});

roster.register('api.example.com', (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'API with custom port range' }));
    };
});

roster.start().then(() => {
    console.log('\n🚀 Server Started with custom port range:');
    console.log('example.com →', roster.getLocalUrl('example.com'));
    console.log('api.example.com →', roster.getLocalUrl('api.example.com'));
    
    console.log('\n✅ Both domains running in custom port range (5000-5100)!');
});
