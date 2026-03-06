#!/usr/bin/env node
'use strict';

var log = require('lemonlog')('greenlock-cli');
var args = process.argv.slice(2);
var arg0 = args[0];

var found = [
    'certonly',
    'add',
    'update',
    'config',
    'defaults',
    'remove',
    'init'
].some(function(k) {
    if (k === arg0) {
        require('./' + k);
        return true;
    }
});

if (!found) {
    log.error("Command '%s' not implemented", arg0 || '(none)');
    process.exit(1);
}
