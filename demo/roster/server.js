const Roster = require('../../index.js');
const path = require('path');

const roster = new Roster({
    local: true,
    email: 'admin@example.com',
    wwwPath: path.join(__dirname, '..', 'www'),
});

roster.start();