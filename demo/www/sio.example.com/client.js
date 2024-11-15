const { io } = require("socket.io-client");

// Connect to the server
const socket = io('https://sio.example.com', {
    rejectUnauthorized: false  // Only use this in development
});

// Handle connection
socket.on('connect', () => {
    console.log('Connected to server');
    
    // Start ping-pong
    setInterval(() => {
        const timestamp = Date.now();
        console.log('Sending ping...');
        
        // Send message
        socket.emit('chat:message', {
            type: 'ping',
            timestamp: timestamp
        });
    }, 5000); // Send ping every 5 seconds
});

// Listen for messages
socket.on('chat:message', (msg) => {
    if (msg.type === 'ping') {
        // Respond to ping with pong
        socket.emit('chat:message', {
            type: 'pong',
            originalTimestamp: msg.timestamp,
            timestamp: Date.now()
        });
    } else if (msg.type === 'pong') {
        // Calculate latency
        const latency = Date.now() - msg.originalTimestamp;
        console.log(`Received pong! Latency: ${latency}ms`);
    }
});

// Handle disconnection
socket.on('disconnect', () => {
    console.log('Disconnected from server');
});

// Handle errors
socket.on('error', (error) => {
    console.error('Socket error:', error);
}); 