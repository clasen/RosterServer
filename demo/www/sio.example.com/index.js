const { Server } = require('socket.io');

module.exports = (server) => {
    const io = new Server(server);

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
        res.writeHead(200);
        res.end('Socket.IO server running');
    };
};