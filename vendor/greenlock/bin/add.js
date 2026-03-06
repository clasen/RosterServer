'use strict';

var log = require('lemonlog')('greenlock-add');
var args = process.argv.slice(3);
var cli = require('./lib/cli.js');
//var path = require('path');
//var pkgpath = path.join(__dirname, '..', 'package.json');
//var pkgpath = path.join(process.cwd(), 'package.json');

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
    cli.main(function(argList, flags) {
        Flags.mangleFlags(flags, mconf);
        main(argList, flags, greenlock);
    }, args);
});

async function main(_, flags, greenlock) {
    if (!flags.subject || !flags.altnames) {
        log.error('Provide --subject and --altnames (valid domains)');
        process.exit(1);
        return;
    }

    greenlock
        .add(flags)
        .catch(function(err) {
            log.error('Add failed:', err.message);
            process.exit(1);
        })
        .then(function() {
            return greenlock
                ._config({
                    servername:
                        flags.altnames[
                            Math.floor(Math.random() * flags.altnames.length)
                        ]
                })
                .then(function(site) {
                    if (!site) {
                        log.error('No config found after add (internal mismatch)');
                        process.exit(1);
                        return;
                    }
                    log.info('Site config:', site);
                });
        });
}
