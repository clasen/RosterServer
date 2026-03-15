'use strict';

const fs = require('fs');
const path = require('path');
const { createStaticHandler } = require('./static-site-handler.js');

/**
 * Resolve a site app for a domain directory.
 * Tries index.js / index.mjs / index.cjs first; falls back to static (index.html) if present.
 * @param {string} domainPath - Absolute path to the domain folder (e.g. www/example.com)
 * @param {{ filename?: string }} options - Optional. filename defaults to 'index'.
 * @returns {Promise<{ siteApp: function, type: 'js' | 'static' } | null>}
 */
async function resolveSiteApp(domainPath, options = {}) {
    const filename = options.filename || 'index';
    const possibleIndexFiles = ['js', 'mjs', 'cjs'].map(ext => `${filename}.${ext}`);

    for (const indexFile of possibleIndexFiles) {
        const indexPath = path.join(domainPath, indexFile);
        if (fs.existsSync(indexPath)) {
            try {
                let siteApp = await import(indexPath).catch(() => {
                    return require(indexPath);
                });
                siteApp = siteApp.default || siteApp;
                return { siteApp, type: 'js' };
            } catch (err) {
                throw err;
            }
        }
    }

    const indexHtmlPath = path.join(domainPath, 'index.html');
    if (fs.existsSync(indexHtmlPath)) {
        const siteApp = createStaticHandler(domainPath);
        return { siteApp, type: 'static' };
    }

    return null;
}

module.exports = { resolveSiteApp };
