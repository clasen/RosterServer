'use strict';

const RECORD_HEADER_BYTES = 5;
const HANDSHAKE_RECORD = 0x16;
const CLIENT_HELLO = 0x01;
const SERVER_NAME_EXTENSION = 0x0000;
const HOST_NAME = 0x00;
// TLS limits a record to 16 KiB; a ClientHello spanning more than four records is not a browser handshake.
const MAX_CLIENT_HELLO_BYTES = 4 * (RECORD_HEADER_BYTES + 16384);

function readServerName(hello) {
    let offset = 4 + 2 + 32;
    offset += 1 + hello[offset];
    offset += 2 + hello.readUInt16BE(offset);
    offset += 1 + hello[offset];
    const extensionsEnd = offset + 2 + hello.readUInt16BE(offset);
    offset += 2;
    while (offset + 4 <= extensionsEnd) {
        const type = hello.readUInt16BE(offset);
        const length = hello.readUInt16BE(offset + 2);
        offset += 4;
        if (type === SERVER_NAME_EXTENSION) {
            const listEnd = offset + 2 + hello.readUInt16BE(offset);
            let entry = offset + 2;
            while (entry + 3 <= listEnd) {
                const nameLength = hello.readUInt16BE(entry + 1);
                if (hello[entry] === HOST_NAME) {
                    return hello.toString('ascii', entry + 3, entry + 3 + nameLength).toLowerCase().replace(/\.$/, '') || null;
                }
                entry += 3 + nameLength;
            }
            return null;
        }
        offset += length;
    }
    return null;
}

/**
 * Extract the SNI host name from the first bytes a TLS client sends.
 * @param {Buffer} buffer - Bytes received so far on the connection.
 * @returns {string|null|undefined} The lowercase server name, `null` when the bytes are not a
 * ClientHello carrying one, or `undefined` when more bytes are needed to decide.
 */
function parseClientHello(buffer) {
    const fragments = [];
    let offset = 0;
    while (true) {
        if (buffer.length >= MAX_CLIENT_HELLO_BYTES) return null;
        if (buffer.length < offset + RECORD_HEADER_BYTES) return undefined;
        if (buffer[offset] !== HANDSHAKE_RECORD) return null;
        const recordEnd = offset + RECORD_HEADER_BYTES + buffer.readUInt16BE(offset + 3);
        if (buffer.length < recordEnd) return undefined;
        fragments.push(buffer.subarray(offset + RECORD_HEADER_BYTES, recordEnd));
        offset = recordEnd;
        const hello = Buffer.concat(fragments);
        if (hello.length < 4) continue;
        if (hello[0] !== CLIENT_HELLO) return null;
        if (hello.length < 4 + hello.readUIntBE(1, 3)) continue;
        try {
            return readServerName(hello);
        } catch {
            return null;
        }
    }
}

module.exports = { parseClientHello };
