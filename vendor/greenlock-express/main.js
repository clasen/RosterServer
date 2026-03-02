"use strict";

// this is the stuff that should run in the main foreground process,
// whether it's single or master

var major = parseInt(process.versions.node.split(".")[0], 10);
var minor = parseInt(process.versions.node.split(".")[1], 10) || 0;
var _hasSetSecureContext = false;
var shouldUpgrade = false;

// this applies to http2 as well (should exist in both or neither)
_hasSetSecureContext = major > 11 || (major === 11 && minor >= 2);

// TODO document in issues
if (!_hasSetSecureContext) {
    // TODO this isn't necessary if greenlock options are set with options.cert
    console.warn("Warning: node " + process.version + " is missing tlsSocket.setSecureContext().");
    console.warn("         The default certificate may not be set.");
    shouldUpgrade = true;
}

if (major < 11 || (11 === major && minor < 2)) {
    // https://github.com/nodejs/node/issues/24095
    console.warn("Warning: node " + process.version + " is missing tlsSocket.getCertificate().");
    console.warn("         This is necessary to guard against domain fronting attacks.");
    shouldUpgrade = true;
}

if (shouldUpgrade) {
    console.warn("Warning: Please upgrade to node v11.2.0 or greater.");
    console.warn();
}
