const SxServer = require('shotx/server').default;

module.exports = (httpsServer) => {
    const server = new SxServer(httpsServer, {}, { auto404: true });

    return (req, res) => {
        if (req.url && req.url.startsWith(server.io.opts.path)) return;
        res.writeHead(200);
        res.end('ShotX server running');
    };
}