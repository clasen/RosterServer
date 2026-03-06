"use strict";

module.exports.create = function(opts) {
    var Greenlock = require("@root/greenlock");
    var log = require("lemonlog")("greenlock-shim");
    //var Init = require("@root/greenlock/lib/init.js");
    var greenlock = opts.greenlock;

    /*
    if (!greenlock && opts.packageRoot) {
        try {
            greenlock = require(path.resolve(opts.packageRoot, "greenlock.js"));
        } catch (e) {
            if ("MODULE_NOT_FOUND" !== e.code) {
                throw e;
            }
        }
    }
    */

    if (!greenlock) {
        //opts = Init._init(opts);
        greenlock = Greenlock.create(opts);
    }
    opts.packageAgent = addGreenlockAgent(opts);

    try {
        if (opts.notify) {
            greenlock._defaults.notify = opts.notify;
        }
    } catch (e) {
        log.error("Developer Error: notify not attached correctly");
    }

    // re-export as top-level function to simplify rpc with workers
    greenlock.getAcmeHttp01ChallengeResponse = function(opts) {
        return greenlock.challenges.get(opts);
    };

    greenlock._find({}).then(function(sites) {
        if (sites.length <= 0) {
            log.warn("Warning: `find({})` returned 0 sites.");
            log.warn("         Does `" + greenlock.manager._modulename + "` implement `find({})`?");
            log.warn("         Did you add sites?");
            log.warn("         npx greenlock add --subject example.com --altnames example.com");
            return;
        }
    });

    return greenlock;
};

function addGreenlockAgent(opts) {
    // Add greenlock as part of Agent, unless this is greenlock
    var packageAgent = opts.packageAgent || "";
    if (!/greenlock(-express|-pro)?/i.test(packageAgent)) {
        var pkg = require("./package.json");
        packageAgent += " Greenlock_Express/" + pkg.version;
    }

    return packageAgent.trim();
}
