const path = require('path');
const file = path.join(__dirname, '..', '..', 'index.js');
const Roster = require(file);

const roster = new Roster({
    email: 'admin@example.com',
});

roster.register('example.com', (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('"Loco de pensar, queriendo entrar en razón, y el corazón tiene razones que la propia razón nunca entenderá."');
    };
});

roster.start();