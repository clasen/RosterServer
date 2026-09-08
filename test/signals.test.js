'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function runChild(t, body, onMessage = () => {}) {
    const script = `
        const assert = require('node:assert/strict');
        const http = require('node:http');
        const Roster = require(${JSON.stringify(require.resolve('../index.js'))});
        const options = { local: true, wwwPath: '/tmp/roster-signals-' + process.pid };
        const signals = ['SIGINT', 'SIGTERM'];
        (async () => { ${body} })().catch(error => {
            console.error(error);
            process.exitCode = 1;
        }).finally(() => process.disconnect());
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => {
        messages.push(message);
        onMessage(message, child);
    });
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const [code, signal] = await once(child, 'close');
    return { code, signal, messages, stderr };
}

function assertSuccess(result) {
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
}

it('does not install signal listeners unless explicitly enabled', { timeout: 10000 }, async t => {
    assertSuccess(await runChild(t, `
        const before = signals.map(signal => process.listeners(signal));
        for (const handleSignals of [undefined, false]) {
            const roster = new Roster({ ...options, handleSignals });
            await roster.init();
            signals.forEach((signal, i) => assert.deepEqual(process.listeners(signal), before[i]));
            await roster.close();
            signals.forEach((signal, i) => assert.deepEqual(process.listeners(signal), before[i]));
        }
    `));
});

it('installs listeners once at initialization and removes only the closing instance listeners', { timeout: 10000 }, async t => {
    assertSuccess(await runChild(t, `
        const existing = () => {};
        signals.forEach(signal => process.on(signal, existing));
        const before = signals.map(signal => process.listeners(signal));
        const first = new Roster({ ...options, handleSignals: true });
        const second = new Roster({ ...options, handleSignals: true });
        signals.forEach((signal, i) => assert.deepEqual(process.listeners(signal), before[i]));
        await Promise.all([first.init(), first.init(), second.init()]);
        signals.forEach((signal, i) => assert.equal(process.listenerCount(signal), before[i].length + 2));
        await Promise.all([first.close(), first.close()]);
        signals.forEach((signal, i) => {
            assert.equal(process.listenerCount(signal), before[i].length + 1);
            assert.ok(process.listeners(signal).includes(existing));
        });
        await second.close();
        signals.forEach((signal, i) => assert.deepEqual(process.listeners(signal), before[i]));
    `));
});

it('removes signal listeners after initialization and cleanup both fail', { timeout: 10000 }, async t => {
    assertSuccess(await runChild(t, `
        const before = signals.map(signal => process.listeners(signal));
        const roster = new Roster({ ...options, handleSignals: true });
        roster.register('example.com', virtual => {
            virtual.onClose(() => { throw new Error('cleanup failed'); });
            throw new Error('factory failed');
        });
        await assert.rejects(roster.init(), AggregateError);
        signals.forEach((signal, i) => assert.deepEqual(process.listeners(signal), before[i]));
    `));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`drains HTTP and runs hooks once on real ${signal}, including repeated signals`, { timeout: 10000 }, async t => {
        const result = await runChild(t, `
            const roster = new Roster({ ...options, handleSignals: true });
            roster.assignPortToDomain = () => 0;
            let cleaned = 0;
            let finished = false;
            let response;
            const repeated = new Promise(resolve => process.once(${JSON.stringify(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT')}, resolve));
            roster.register('example.com', virtual => {
                virtual.on('close', () => {
                    process.send('closing');
                    setImmediate(() => { finished = true; response.end(' drained'); });
                });
                virtual.onClose(async () => {
                    assert.equal(finished, true);
                    await repeated;
                    cleaned++;
                });
                return (req, res) => {
                    response = res;
                    res.write('active');
                };
            });
            await Promise.all([roster.start(), roster.start()]);
            const server = roster.portServers[0];
            const body = await new Promise((resolve, reject) => {
                http.get({ hostname: 'localhost', port: server.address().port, agent: false }, res => {
                    let body = '';
                    res.once('data', () => process.send('ready'));
                    res.on('data', chunk => { body += chunk; });
                    res.on('end', () => resolve(body));
                    res.on('error', reject);
                }).on('error', reject);
            });
            await roster.close();
            assert.equal(body, 'active drained');
            assert.equal(cleaned, 1);
            assert.equal(server.listening, false);
            signals.forEach(signal => assert.equal(process.listenerCount(signal), 0));
            process.send('complete');
        `, (message, child) => {
            if (message === 'ready') child.kill(signal);
            if (message === 'closing') child.kill(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
        });
        assertSuccess(result);
        assert.deepEqual(result.messages, ['ready', 'closing', 'complete']);
    });
}

it('reports signal-triggered cleanup failure with exit code 1 and removes listeners', { timeout: 10000 }, async t => {
    const result = await runChild(t, `
        const roster = new Roster({ ...options, handleSignals: true });
        roster.assignPortToDomain = () => 0;
        let entered;
        const closing = new Promise(resolve => { entered = resolve; });
        roster.register('example.com', virtual => {
            virtual.on('close', entered);
            virtual.onClose(() => { throw new Error('cleanup failed'); });
            return (req, res) => res.end();
        });
        await roster.start();
        process.send('ready');
        await closing;
        await assert.rejects(roster.close(), AggregateError);
        signals.forEach(signal => assert.equal(process.listenerCount(signal), 0));
        assert.equal(process.exitCode, 1);
        process.send('complete');
    `, (message, child) => { if (message === 'ready') child.kill('SIGTERM'); });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(result.messages, ['ready', 'complete']);
});

it('handles signals during initialization and cleans up its listeners', { timeout: 10000 }, async t => {
    const result = await runChild(t, `
        const roster = new Roster({ ...options, handleSignals: true });
        let release;
        roster.loadSites = () => new Promise(resolve => { release = resolve; });
        let called = false;
        roster.register('example.com', () => { called = true; });
        const initializing = assert.rejects(roster.init(), /closing or closed/);
        process.once('message', () => release());
        const close = roster.close.bind(roster);
        roster.close = () => { const result = close(); process.send('closing'); return result; };
        process.send('ready');
        await initializing;
        await close();
        assert.equal(called, false);
        signals.forEach(signal => assert.equal(process.listenerCount(signal), 0));
        process.send('complete');
    `, (message, child) => {
        if (message === 'ready') child.kill('SIGTERM');
        if (message === 'closing') child.send('release');
    });
    assertSuccess(result);
    assert.deepEqual(result.messages, ['ready', 'closing', 'complete']);
});
