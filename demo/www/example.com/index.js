module.exports = (server) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('"Loco de pensar, queriendo entrar en razón, y el corazón tiene razones que la propia razón nunca entenderá."');
    };
};