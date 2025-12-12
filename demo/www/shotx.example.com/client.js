const SxClient = require('shotx/client').default;

const client = new SxClient('http://localhost:3002');

(async () => {

    const login = await client.connect('valid');
    console.log('CLIENT --> Login:', login);

    // Join a room
    await client.join('user-room');
    console.log('CLIENT --> Joined room: user-room');

    // Set up message handlers for specific routes
    client.onMessage('notification', async (data, socket) => {
        console.log('CLIENT --> Received notification:', data);
    });
})();