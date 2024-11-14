module.exports = (req, res) => {
    // Send a simple response
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
        <!DOCTYPE html>
        <html>
            <head>
                <title>Example Site</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        max-width: 800px;
                        margin: 40px auto;
                        padding: 0 20px;
                        line-height: 1.6;
                    }
                    h1 { color: #333; }
                </style>
            </head>
            <body>
                <h1>Welcome to Example.com</h1>
                <p>This is a sample page served by the Roster server.</p>
                <p>Request received from: ${req.headers.host}</p>
                <p>URL path: ${req.url}</p>
            </body>
        </html>
    `);
};