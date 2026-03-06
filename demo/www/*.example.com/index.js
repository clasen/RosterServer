module.exports = (httpsServer) => {
    return (req, res) => {
        const host = req.headers.host || 'unknown';
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(
            `Wildcard *.example.com – you requested: ${host}\n` +
            'Any subdomain (api.example.com, app.example.com, …) uses this same handler.'
        );
    };
};
