var DIR = module.exports;
var log = require('lemonlog')('greenlock-dir');

DIR._getDirectoryUrl = function(dirUrl, domain) {
    var liveUrl = 'https://acme-v02.api.letsencrypt.org/directory';
    dirUrl = DIR._getDefaultDirectoryUrl(dirUrl, '', domain);
    if (!dirUrl) {
        dirUrl = liveUrl;
        if (!DIR._shownDirectoryUrl) {
            DIR._shownDirectoryUrl = true;
            log.info('ACME directory URL:', dirUrl);
        }
    }
    return dirUrl;
};

// Handle staging URLs, pebble test server, etc
DIR._getDefaultDirectoryUrl = function(dirUrl, staging, domain) {
    var stagingUrl = 'https://acme-staging-v02.api.letsencrypt.org/directory';
    var stagingRe = /(^http:|staging|^127\.0\.|^::|localhost)/;
    var env = '';
    var args = [];
    if ('undefined' !== typeof process) {
        env = (process.env && process.env.ENV) || '';
        args = (process.argv && process.argv.slice(1)) || [];
    }

    if (
        staging ||
        stagingRe.test(dirUrl) ||
        args.includes('--staging') ||
        /DEV|STAG/i.test(env)
    ) {
        if (!stagingRe.test(dirUrl)) {
            dirUrl = stagingUrl;
        }
        log.info('Staging ACME directory:', dirUrl, env);
        log.warn('Staging mode: fake certificates for testing only', env, domain);
    }

    return dirUrl;
};

DIR._shownDirectoryUrl = false;
