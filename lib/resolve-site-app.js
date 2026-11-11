'use strict';

const fs = require('fs');
const path = require('path');
const { createStaticHandler } = require('./static-site-handler.js');

// TypeScript entries rely on the runtime stripping types: Bun, or Node.js 22.18+.
const SITE_ENTRY_EXTENSIONS = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'];

/**
 * Locate a site's entry without loading it.
 * Tries the script entries in SITE_ENTRY_EXTENSIONS order first; falls back to static (index.html) if present.
 * @param {string} domainPath - Absolute path to the domain folder (e.g. www/example.com)
 * @param {{ filename?: string }} options - Optional. filename defaults to 'index'.
 * @returns {{ type: 'js' | 'static', path: string } | null}
 */
function locateSiteEntry(domainPath, options = {}) {
    const filename = options.filename || 'index';
    for (const extension of SITE_ENTRY_EXTENSIONS) {
        const indexPath = path.join(domainPath, `${filename}.${extension}`);
        if (fs.existsSync(indexPath)) return { type: 'js', path: indexPath };
    }
    const indexHtmlPath = path.join(domainPath, 'index.html');
    if (fs.existsSync(indexHtmlPath)) return { type: 'static', path: indexHtmlPath };
    return null;
}

function missingSiteEntryMessage(domainPath) {
    return `No index file (${SITE_ENTRY_EXTENSIONS.join('/')} or index.html) found in ${domainPath}`;
}

/**
 * Resolve a site app for a domain directory.
 * @param {string} domainPath - Absolute path to the domain folder (e.g. www/example.com)
 * @param {{ filename?: string }} options - Optional. filename defaults to 'index'.
 * @returns {Promise<{ siteApp: function, type: 'js' | 'static' } | null>}
 */
async function resolveSiteApp(domainPath, options = {}) {
    const entry = locateSiteEntry(domainPath, options);
    if (!entry) return null;
    if (entry.type === 'static') {
        return { siteApp: createStaticHandler(domainPath), type: 'static' };
    }
    let siteApp = await import(entry.path).catch(() => {
        return require(entry.path);
    });
    siteApp = siteApp.default || siteApp;
    return { siteApp, type: 'js' };
}

/**
 * A socket site exports `{ start?(context), connection(socket, head), close?() }` and serves
 * raw client connections itself, including TLS. Only an isolated site process can hand it sockets.
 */
function isSocketSite(siteApp) {
    return typeof siteApp === 'object' && siteApp !== null && typeof siteApp.connection === 'function';
}

module.exports = { locateSiteEntry, missingSiteEntryMessage, resolveSiteApp, isSocketSite };
