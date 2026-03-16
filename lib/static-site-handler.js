'use strict';

const fs = require('fs');
const path = require('path');

const MIME_BY_EXT = {
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    eot: 'application/vnd.ms-fontobject',
    map: 'application/json',
    txt: 'text/plain',
    xml: 'application/xml',
    pdf: 'application/pdf'
};

const DEFAULT_MIME = 'application/octet-stream';

/**
 * Resolve request path to a safe filesystem path under rootPath.
 * Returns null if path escapes rootPath (traversal) or is invalid.
 * @param {string} rootPath - Absolute directory root
 * @param {string} requestPath - URL path (e.g. /css/style.css)
 * @returns {string|null} Absolute file path or null
 */
function resolvePath(rootPath, requestPath) {
    const normalized = path.normalize(requestPath.replace(/^\//, '').replace(/\/+/g, path.sep));
    if (normalized.startsWith('..') || normalized.includes('..' + path.sep) || normalized.includes(path.sep + '..')) {
        return null;
    }
    const realRoot = path.resolve(rootPath);
    const absolute = path.resolve(rootPath, normalized);
    if (absolute !== realRoot && !absolute.startsWith(realRoot + path.sep)) {
        return null;
    }
    return absolute;
}

/**
 * Get Content-Type for a file path.
 * @param {string} filePath
 * @returns {string}
 */
function getContentType(filePath) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return MIME_BY_EXT[ext] || DEFAULT_MIME;
}

/**
 * Create a static site handler that serves files from rootPath.
 * Compatible with Roster contract: (virtualServer) => (req, res) => void.
 * - GET / or /index.html serves index.html
 * - Serves existing files by path; 404 otherwise (strict mode)
 * - Path traversal protected
 * @param {string} rootPath - Absolute path to site root (e.g. www/example.com)
 * @returns {function(virtualServer): function(req, res): void}
 */
function createStaticHandler(rootPath) {
    const root = path.resolve(rootPath);

    return function staticSiteFactory(virtualServer) {
        return function staticHandler(req, res) {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { 'Content-Type': 'text/plain' });
                res.end('Method Not Allowed');
                return;
            }

            let requestPath = (req.url || '/').split('?')[0];
            if (requestPath === '' || requestPath === '/') {
                requestPath = '/index.html';
            }

            const filePath = resolvePath(root, requestPath);
            if (!filePath) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden');
                return;
            }

            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }

            const stat = fs.statSync(filePath);
            let servePath = filePath;
            if (!stat.isFile()) {
                if (!stat.isDirectory()) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                    return;
                }
                const indexInDir = path.join(filePath, 'index.html');
                if (!fs.existsSync(indexInDir) || !fs.statSync(indexInDir).isFile()) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                    return;
                }
                servePath = indexInDir;
            }

            const contentType = getContentType(servePath);
            const content = fs.readFileSync(servePath);

            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': content.length
            });
            if (req.method === 'GET') {
                res.end(content);
            } else {
                res.end();
            }
        };
    };
}

module.exports = { createStaticHandler, resolvePath, getContentType, MIME_BY_EXT };
