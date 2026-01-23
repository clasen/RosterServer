module.exports = (httpsServer) => {
    return (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('"subdomain.example.com: Crazy from thinking, wanting to be reasonable, and the heart has reasons that reason itself will never understand."');
    };
};