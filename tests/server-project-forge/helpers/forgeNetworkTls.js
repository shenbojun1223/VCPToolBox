'use strict';
// Synthetic TLS material generated only in test memory. Never suitable as a deployed identity.
const crypto = require('node:crypto');
function der(tag, ...parts) {
    const body = Buffer.concat(parts);
    let length;
    if (body.length < 128) length = Buffer.from([body.length]);
    else {
        const bytes = [];
        for (let n = body.length; n; n = Math.floor(n / 256)) bytes.unshift(n & 255);
        length = Buffer.from([0x80 | bytes.length, ...bytes]);
    }
    return Buffer.concat([Buffer.from([tag]), length, body]);
}
const seq = (...parts) => der(0x30, ...parts);
const oid = hex => der(0x06, Buffer.from(hex, 'hex'));
const pem = (type, data) => '-----BEGIN ' + type + '-----\n' +
    data.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END ' + type + '-----\n';
function syntheticTls() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const algorithm = seq(oid('2a864886f70d01010b'), der(0x05));
    const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('Forge synthetic loopback')))));
    const serial = crypto.randomBytes(16); serial[0] &= 0x7f; serial[0] |= 1;
    const tbs = seq(
        der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm, name,
        seq(der(0x17, Buffer.from('200101000000Z')), der(0x17, Buffer.from('490101000000Z'))),
        name, publicKey.export({ type: 'spki', format: 'der' }),
        der(0xa3, seq(
            seq(oid('551d13'), der(0x01, Buffer.from([255])),
                der(0x04, seq(der(0x01, Buffer.from([255]))))),
            seq(oid('551d11'), der(0x04, seq(der(0x87, Buffer.from([127, 0, 0, 1])))))
        )),
    );
    const certificate = seq(tbs, algorithm, der(0x03, Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)));
    return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', certificate) };
}
module.exports = { syntheticTls };