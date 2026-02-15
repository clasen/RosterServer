const Roster = require('../index.js');
const { Server } = require('socket.io');

const roster = new Roster({ local: true });

roster.register('example.com', (httpsServer) => {
    const io = new Server(httpsServer);

    io.on('connection', (socket) => {
        console.log('A user connected');

        socket.on('chat:message', (msg) => {
            console.log('Message received:', msg);
            io.emit('chat:message', msg);
        });

        socket.on('disconnect', () => {
            console.log('User disconnected');
        });
    });

    return (req, res) => {
        if (req.url && req.url.startsWith(io.opts.path)) return;
        res.writeHead(404);
        res.end('Not found');
    };
});

roster.start().then(() => {
    // Get local URL for registered domain (requires instance)
    const url = roster.getLocalUrl('example.com');
    console.log(`✅ Socket.IO server available at: ${url}`);
    
    // Get local URL without instance (static method - predictable port)
    const staticUrl = Roster.getLocalUrl('example.com');
    console.log(`ℹ️  Static prediction: ${staticUrl}`);
});