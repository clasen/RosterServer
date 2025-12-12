const { Server } = require('socket.io');

const app = (httpsServer) => {
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

    // Devolvemos el handler para las peticiones HTTP
    return (req, res) => {
        if (req.url && req.url.startsWith(io.opts.path)) return;
        res.writeHead(200);
        res.end('Socket.IO server running');
    };
};

module.exports = app;