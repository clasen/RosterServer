var log = require('lemonlog')('greenlock-order');
var accountKeypair = await Keypairs.generate({ kty: accKty });
if (config.debug) {
    log.info('Account key created', accountKeypair);
}

var account = await acme.accounts.create({
    agreeToTerms: agree,
    // TODO detect jwk/pem/der?
    accountKeypair: { privateKeyJwk: accountKeypair.private },
    subscriberEmail: config.email
});

// TODO top-level agree
function agree(tos) {
    if (config.debug) log.info('Agreeing to Terms of Service:', tos);
    agreed = true;
    return Promise.resolve(tos);
}
if (config.debug) log.info('New subscriber account', account);
if (!agreed) {
    throw new Error('Failed to ask the user to agree to terms');
}

var certKeypair = await Keypairs.generate({ kty: srvKty });
var pem = await Keypairs.export({
    jwk: certKeypair.private,
    encoding: 'pem'
});
if (config.debug) {
    log.info('Server key created (privkey.%s.pem)', srvKty.toLowerCase(), certKeypair);
}

// 'subject' should be first in list
var domains = randomDomains(rnd);
if (config.debug) {
    log.info('Requesting certificates for domains:', domains.map(function(p) {
        var u = punycode.toUnicode(p);
        return p !== u ? p + ' (' + u + ')' : p;
    }).join(', '));
}

// Create CSR
var csrDer = await CSR.csr({
    jwk: certKeypair.private,
    domains: domains,
    encoding: 'der'
});
var csr = Enc.bufToUrlBase64(csrDer);
var csrPem = PEM.packBlock({
    type: 'CERTIFICATE REQUEST',
    bytes: csrDer /* { jwk: jwk, domains: opts.domains } */
});
if (config.debug) log.info('Certificate signing request (CSR) created');

var results = await acme.certificates.create({
    account: account,
    accountKeypair: { privateKeyJwk: accountKeypair.private },
    csr: csr,
    domains: domains,
    challenges: challenges, // must be implemented
    customerEmail: null
});
