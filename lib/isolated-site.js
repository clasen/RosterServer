'use strict';

const path = require('path');
const { fork } = require('child_process');
const log = require('lemonlog')('roster');

const WORKER_PATH = path.join(__dirname, 'site-worker.js');

function serializeError(error) {
    if (!(error instanceof Error)) return { message: String(error) };
    return { name: error.name, message: error.message, stack: error.stack, code: error.code };
}

function deserializeError(data) {
    const error = new Error(data.message);
    if (data.name) error.name = data.name;
    if (data.stack) error.stack = data.stack;
    if (data.code !== undefined) error.code = data.code;
    return error;
}

/**
 * A site that runs in its own process. The main process hands it raw client
 * sockets; the site process terminates TLS and serves them.
 */
class IsolatedSite {
    /**
     * @param {object} site
     * @param {string} site.name - Label for logs and the process title.
     * @param {object} site.config - Serializable start payload for the site process.
     * @param {{ restartDelayMs: number, backlog: number }} site.isolation
     * @param {(servername: string) => Promise<unknown>} site.issueCertificate
     */
    constructor({ name, config, isolation, issueCertificate }) {
        this.name = name;
        this.config = config;
        this.isolation = isolation;
        this.issueCertificate = issueCertificate;
        this.localPorts = {};
        this.child = null;
        this.ready = false;
        this.pending = 0;
        this._closing = null;
        this._resolveClose = null;
        this._restartTimer = null;
    }

    start() {
        return new Promise((resolve, reject) => this._spawn({ resolve, reject }));
    }

    _spawn(startup) {
        if (this._closing) {
            startup?.reject(new Error('Roster is closing or closed'));
            return;
        }
        const child = fork(WORKER_PATH, [], { serialization: 'json' });
        this.child = child;
        let failure = null;
        let closedErrors = null;
        child.on('message', message => {
            if (message.type === 'ready') {
                this.ready = true;
                if (startup) {
                    log.info(`(✔) Isolated site ${this.name} (pid ${child.pid})`);
                    startup.resolve();
                    startup = null;
                } else {
                    log.info(`(✔) Isolated site ${this.name} restarted (pid ${child.pid})`);
                }
            } else if (message.type === 'failed') {
                failure = deserializeError(message.error);
            } else if (message.type === 'certificate') {
                this._issueCertificate(child, message);
            } else if (message.type === 'closed') {
                closedErrors = message.errors.map(deserializeError);
            }
        });
        child.on('error', error => { failure = failure || error; });
        child.once('exit', (code, signal) => {
            this.child = null;
            this.ready = false;
            this.pending = 0;
            const reason = failure || new Error(`Isolated site ${this.name} exited with ${signal || `code ${code}`}`);
            if (startup) startup.reject(this._closing ? new Error('Roster is closing or closed') : reason);
            if (this._resolveClose) {
                this._resolveClose(closedErrors || [reason]);
                return;
            }
            if (startup) return;
            log.error(`❌ Isolated site ${this.name} stopped: ${reason.message}. Restarting in ${this.isolation.restartDelayMs} ms`);
            this._restartTimer = setTimeout(() => {
                this._restartTimer = null;
                this._spawn(null);
            }, this.isolation.restartDelayMs);
        });
        child.send({ type: 'start', ...this.config, name: this.name, localPorts: this.localPorts });
    }

    _issueCertificate(child, { id, servername }) {
        Promise.resolve()
            .then(() => this.issueCertificate(servername))
            .then(() => ({}), error => ({ error: serializeError(error) }))
            .then(result => {
                if (child.connected) child.send({ type: 'certificate', id, ...result });
            });
    }

    /**
     * Pass an accepted client socket, with the bytes already read from it, to the site process.
     */
    handoff(port, head, socket) {
        const child = this.child;
        if (!this.ready || this.pending >= this.isolation.backlog) {
            socket.destroy();
            return;
        }
        this.pending++;
        child.send({ type: 'connection', port, head: head.toString('base64') }, socket, error => {
            if (this.child === child) this.pending--;
            if (error) socket.destroy();
        });
    }

    /**
     * Ask the site process to drain and run its cleanup hooks, then wait for it to exit.
     * @returns {Promise<Error[]>} Errors reported by the site's shutdown.
     */
    close() {
        if (this._closing) return this._closing;
        clearTimeout(this._restartTimer);
        if (!this.child) {
            this._closing = Promise.resolve([]);
            return this._closing;
        }
        this._closing = new Promise(resolve => { this._resolveClose = resolve; });
        if (this.child.connected) this.child.send({ type: 'close' });
        return this._closing;
    }

    kill() {
        if (this.child) this.child.kill('SIGKILL');
    }
}

module.exports = { IsolatedSite, serializeError };
