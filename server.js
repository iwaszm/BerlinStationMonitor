const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const BVG_API_HOST = 'v6.bvg.transport.rest';

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
};

const server = http.createServer((req, res) => {
    console.log(`[Request] ${req.method} ${req.url}`);

    // API Proxy: Forward requests starting with /api/ to BVG
    // Example: /api/locations?query=... -> https://v6.bvg.transport.rest/locations?query=...
    if (req.url.startsWith('/api/')) {
        const proxyPath = req.url.replace(/^\/api/, ''); // Remove /api prefix
        
        const options = {
            hostname: BVG_API_HOST,
            port: 443,
            path: proxyPath,
            method: req.method,
            headers: {
                ...req.headers,
                host: BVG_API_HOST // Important: Set host header for the target
            }
        };

        const proxyReq = https.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res, { end: true });
        });

        proxyReq.on('error', (e) => {
            console.error(`[Proxy Error] ${e.message}`);
            res.writeHead(500);
            res.end('Proxy Error');
        });

        req.pipe(proxyReq, { end: true });
        return;
    }

    // Static File Serving
    let filePath = '.' + req.url;
    if (filePath === './') {
        filePath = './Dashboard.html';
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

// Need 'https' module for the proxy
const https = require('https');

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`- Dashboard: http://localhost:${PORT}/Dashboard.html`);
    console.log(`- API Proxy: http://localhost:${PORT}/api/...`);
});
