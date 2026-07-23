const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApiProxy, handleHealthz } = require('./lib/apiProxy');

const PORT = process.env.PORT || 3000;
const PUBLIC_ROOT = __dirname;

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
};

const server = http.createServer((req, res) => {
    console.log(`[Request] ${req.method} ${req.url}`);

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (parsedUrl.pathname === '/healthz') {
        handleHealthz(req, res);
        return;
    }

    if (parsedUrl.pathname.startsWith('/api/')) {
        handleApiProxy(req, res, parsedUrl);
        return;
    }

    const rawPath = req.url.split('?')[0].split('#')[0];
    let pathname;
    try {
        pathname = decodeURIComponent(rawPath);
    } catch (e) {
        res.writeHead(400);
        res.end('Bad request');
        return;
    }

    if (pathname === '/') {
        pathname = '/index.html';
    } else if (pathname === '/kindle' || pathname === '/kindle/') {
        pathname = '/kindle.html';
    }

    const filePath = path.resolve(PUBLIC_ROOT, `.${pathname}`);
    if (!filePath.startsWith(PUBLIC_ROOT + path.sep) && filePath !== PUBLIC_ROOT) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
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

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`- Index: http://localhost:${PORT}/index.html`);
    console.log(`- Kindle: http://localhost:${PORT}/kindle`);
    console.log(`- API Proxy: http://localhost:${PORT}/api/...`);
});
