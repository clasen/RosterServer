'use strict';

var log = require('lemonlog')('greenlock-config');
var args = process.argv.slice(3);
var cli = require('./lib/cli.js');
//var path = require('path');
//var pkgpath = path.join(__dirname, '..', 'package.json');
//var pkgpath = path.join(process.cwd(), 'package.json');

var Flags = require('./lib/flags.js');

Flags.init().then(function({ flagOptions, greenlock, mconf }) {
    var myFlags = {};
    ['all', 'subject', 'servername' /*, 'servernames', 'altnames'*/].forEach(
        function(k) {
            myFlags[k] = flagOptions[k];
        }
    );

    cli.parse(myFlags);
    cli.main(function(argList, flags) {
        Flags.mangleFlags(flags, mconf);
        main(argList, flags, greenlock);
    }, args);
});

async function main(_, flags, greenlock) {
    var servernames = [flags.subject]
        .concat([flags.servername])
        //.concat(flags.servernames)
        //.concat(flags.altnames)
        .filter(Boolean);
    delete flags.subject;
    delete flags.altnames;
    flags.servernames = servernames;
    if (!flags.all && flags.servernames.length > 1) {
        log.error('Specify either --subject OR --servername');
        process.exit(1);
        return;
    } else if (!flags.all && flags.servernames.length !== 1) {
        log.error('Missing --servername <example.com>');
        process.exit(1);
        return;
    }
    if (!flags.all) {
        flags.servername = flags.servernames[0];
    } else if (flags.servername) {
        log.error('Cannot use both --all and --servername/--subject');
        process.exit(1);
    }
    delete flags.servernames;

    var getter = function() {
        return greenlock._config(flags);
    };
    if (flags.all) {
        getter = function() {
            return greenlock._configAll(flags);
        };
    }
    return getter()
        .catch(function(err) {
            log.error('Config failed:', err.message);
            process.exit(1);
        })
        .then(function(sites) {
            if (!sites) {
                log.info(flags.all ? 'No configs found' : 'No config for %s', flags.servername);
                process.exit(1);
                return;
            }
            if (!Array.isArray(sites)) sites = [sites];
            sites.forEach(function(site) {
                log.info('Config for %s:', flags.servername || site.subject, site);
            });
        });
}
