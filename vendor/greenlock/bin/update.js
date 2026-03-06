'use strict';

var log = require('lemonlog')('greenlock-update');
var args = process.argv.slice(3);
var cli = require('./lib/cli.js');
var Flags = require('./lib/flags.js');

Flags.init().then(function({ flagOptions, greenlock, mconf }) {
    var myFlags = {};
    [
        'subject',
        'altnames',
        'renew-offset',
        'subscriber-email',
        'customer-email',
        'server-key-type',
        'challenge-http-01',
        'challenge-http-01-xxxx',
        'challenge-dns-01',
        'challenge-dns-01-xxxx',
        'challenge-tls-alpn-01',
        'challenge-tls-alpn-01-xxxx',
        'challenge',
        'challenge-xxxx',
        'challenge-json',
        'force-save'
    ].forEach(function(k) {
        myFlags[k] = flagOptions[k];
    });

    cli.parse(myFlags);
    cli.main(async function(argList, flags) {
        var sconf = await greenlock._config({ servername: flags.subject });
        Flags.mangleFlags(flags, mconf, sconf);
        main(argList, flags, greenlock);
    }, args);
});

async function main(_, flags, greenlock) {
    if (!flags.subject) {
        log.error('Provide --subject (valid domain)');
        process.exit(1);
        return;
    }

    greenlock
        .update(flags)
        .catch(function(err) {
            log.error('Update failed:', err.message);
            process.exit(1);
        })
        .then(function() {
            return greenlock._config({ servername: flags.subject }).then(function(site) {
                if (!site) {
                    log.error('No config found for', flags.subject);
                    process.exit(1);
                    return;
                }
                log.info('Updated site config:', site);
            });
        });
}
