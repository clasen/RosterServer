'use strict';

var log = require('lemonlog')('greenlock-remove');
var args = process.argv.slice(3);
var cli = require('./lib/cli.js');
//var path = require('path');
//var pkgpath = path.join(__dirname, '..', 'package.json');
//var pkgpath = path.join(process.cwd(), 'package.json');

var Flags = require('./lib/flags.js');

Flags.init().then(function({ flagOptions, greenlock, mconf }) {
    var myFlags = {};
    ['subject'].forEach(function(k) {
        myFlags[k] = flagOptions[k];
    });

    cli.parse(myFlags);
    cli.main(function(argList, flags) {
        Flags.mangleFlags(flags, mconf);
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
        .remove(flags)
        .catch(function(err) {
            log.error('Remove failed:', err.message);
            process.exit(1);
        })
        .then(function(site) {
            if (!site) {
                log.info('No config found for', flags.subject);
                process.exit(1);
                return;
            }
            log.info('Deleted config for %s:', flags.subject, site);
        });
}
