'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

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
        return async function staticHandler(req, res) {
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

            let file;
            try {
                let servePath = filePath;
                let stat = await fs.promises.stat(servePath);
                if (stat.isDirectory()) {
                    servePath = path.join(servePath, 'index.html');
                    stat = await fs.promises.stat(servePath);
                }
                if (!stat.isFile()) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                    return;
                }
                file = await fs.promises.open(servePath, 'r');
                stat = await file.stat();
                if (res.destroyed) return;
                if (!stat.isFile()) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': getContentType(servePath),
                    'Content-Length': stat.size
                });
                if (req.method === 'HEAD') {
                    res.end();
                } else {
                    await pipeline(file.createReadStream(), res);
                }
            } catch (error) {
                if (res.destroyed || res.writableEnded) return;
                if (res.headersSent) {
                    res.destroy(error);
                    return;
                }
                const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
                const forbidden = error.code === 'EACCES' || error.code === 'EPERM';
                res.writeHead(missing ? 404 : forbidden ? 403 : 500, { 'Content-Type': 'text/plain' });
                res.end(missing ? 'Not Found' : forbidden ? 'Forbidden' : 'Internal Server Error');
            } finally {
                if (file) await file.close();
            }
        };
    };
}

module.exports = { createStaticHandler, resolvePath, getContentType, MIME_BY_EXT };
