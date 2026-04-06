#!/usr/bin/env node
// scripts/generate-did-keys.js
// Generate Ed25519 key pair for FightClawb DID (did:web:fightclawb.pro)
//
// Usage: node scripts/generate-did-keys.js
//
// Outputs:
//   backend/keys/private-key.pem   (chmod 600)
//   backend/keys/public-key.pem
//   frontend/public/.well-known/did.json

const { generateKeyPairSync, createPublicKey } = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYS_DIR = path.join(__dirname, '..', 'backend', 'keys');
const WELL_KNOWN_DIR = path.join(__dirname, '..', 'frontend', 'public', '.well-known');

// ── Generate Ed25519 Key Pair ────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
});

// ── Save Keys ────────────────────────────────────────────────────────────────

fs.mkdirSync(KEYS_DIR, { recursive: true });
fs.writeFileSync(path.join(KEYS_DIR, 'private-key.pem'), privateKey, { mode: 0o600 });
fs.writeFileSync(path.join(KEYS_DIR, 'public-key.pem'), publicKey);

console.log('Keys generated:');
console.log(`  ${path.join(KEYS_DIR, 'private-key.pem')}  (mode 600)`);
console.log(`  ${path.join(KEYS_DIR, 'public-key.pem')}`);

// ── Extract Raw Public Key → Multibase ───────────────────────────────────────
// Ed25519 SPKI DER is 44 bytes: 12-byte prefix + 32-byte raw key
// We extract the raw 32-byte key and encode as multibase (base58btc, prefix 'z')

const pubKeyObj = createPublicKey(publicKey);
const spkiDer = pubKeyObj.export({ type: 'spki', format: 'der' });
const rawPubKey = spkiDer.subarray(spkiDer.length - 32); // last 32 bytes = raw Ed25519 key

// Multicodec prefix for Ed25519 public key: 0xed01
const multicodecKey = Buffer.concat([Buffer.from([0xed, 0x01]), rawPubKey]);

// Base58btc encode (z prefix)
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btcEncode(buf) {
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // Leading zeros
  for (const byte of buf) {
    if (byte !== 0) break;
    digits.push(0);
  }
  return digits.reverse().map(d => ALPHABET[d]).join('');
}

const publicKeyMultibase = 'z' + base58btcEncode(multicodecKey);

console.log(`  Public key multibase: ${publicKeyMultibase}`);

// ── Build DID Document ───────────────────────────────────────────────────────

const didDocument = {
  '@context': [
    'https://www.w3.org/ns/did/v1',
    'https://w3id.org/security/suites/ed25519-2020/v1'
  ],
  id: 'did:web:fightclawb.pro',
  verificationMethod: [
    {
      id: 'did:web:fightclawb.pro#key-1',
      type: 'Ed25519VerificationKey2020',
      controller: 'did:web:fightclawb.pro',
      publicKeyMultibase: publicKeyMultibase
    }
  ],
  authentication: ['did:web:fightclawb.pro#key-1'],
  assertionMethod: ['did:web:fightclawb.pro#key-1']
};

fs.mkdirSync(WELL_KNOWN_DIR, { recursive: true });
fs.writeFileSync(
  path.join(WELL_KNOWN_DIR, 'did.json'),
  JSON.stringify(didDocument, null, 2) + '\n'
);

console.log(`  DID document: ${path.join(WELL_KNOWN_DIR, 'did.json')}`);
console.log('');
console.log('DID: did:web:fightclawb.pro');
console.log('');
console.log('IMPORTANT:');
console.log('  - NEVER commit backend/keys/ to git');
console.log('  - Deploy frontend to publish DID document at https://fightclawb.pro/.well-known/did.json');
