"use strict";

var log = require("lemonlog")("greenlock-demo");

require("./")
    .init(initialize)
    .serve(worker)
    .master(function() {
        log.info("Hello from master");
    });

function initialize() {
    var pkg = require("./package.json");
    var config = {
        package: {
            name: "Greenlock_Express_Demo",
            version: pkg.version,
            author: pkg.author
        },
        staging: true,
        cluster: true,

        notify: function(ev, params) {
            log.info(ev, params);
        }
    };
    return config;
}

function worker(glx) {
    log.info("");
    log.info("Hello from worker #" + glx.id());

    glx.serveApp(function(req, res) {
        res.end("Hello, Encrypted World!");
    });
}
