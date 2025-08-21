const express = require('express');

module.exports = (httpsServer) => {
    const app = express();
    app.get('/', (req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send('"subdomain.example.com: Loco de pensar, queriendo entrar en razón, y el corazón tiene razones que la propia razón nunca entenderá."');
    });

    return app;
}