// services/arena-identity/src/utils/did.js
// DID and Verifiable Credential utilities for FightClawb
//
// Uses Node.js built-in crypto for Ed25519 signing.
// No external VC libraries needed — we produce W3C VC Data Model v1 compliant
// credentials with Ed25519Signature2020 proofs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Key Paths ────────────────────────────────────────────────────────────────

const KEYS_DIR = process.env.KEYS_DIR
  || path.join(__dirname, '..', '..', '..', '..', 'backend', 'keys');

const DID_DOC_PATH = process.env.DID_DOC_PATH
  || path.join(__dirname, '..', '..', '..', '..', 'frontend', 'public', '.well-known', 'did.json');

// ── Key Loading ──────────────────────────────────────────────────────────────

let _privateKey = null;
let _didDocument = null;

function loadPrivateKey() {
  if (_privateKey) return _privateKey;
  const keyPath = path.join(KEYS_DIR, 'private-key.pem');
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Private key not found at ${keyPath}. Run: node scripts/generate-did-keys.js`
    );
  }
  _privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  return _privateKey;
}

function loadDIDDocument() {
  if (_didDocument) return _didDocument;
  if (!fs.existsSync(DID_DOC_PATH)) {
    throw new Error(
      `DID document not found at ${DID_DOC_PATH}. Run: node scripts/generate-did-keys.js`
    );
  }
  _didDocument = JSON.parse(fs.readFileSync(DID_DOC_PATH, 'utf8'));
  return _didDocument;
}

// ── Credential Building ──────────────────────────────────────────────────────

const ISSUER_DID = 'did:web:fightclawb.pro';
const VERIFICATION_METHOD = 'did:web:fightclawb.pro#key-1';

/**
 * Build an unsigned W3C Verifiable Credential for an agent's battle record.
 *
 * @param {object} agent - Agent data from database
 * @param {object} stats - Computed stats (peakElo, winRate, totalMatches)
 * @returns {object} Unsigned credential (no proof yet)
 */
function buildCredential(agent, stats) {
  const now = new Date().toISOString();

  return {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1'
    ],
    type: ['VerifiableCredential', 'FightClawbBattleRecord'],
    issuer: ISSUER_DID,
    issuanceDate: now,
    credentialSubject: {
      id: agent.did,
      agentId: agent.agent_id,
      agentName: agent.display_name || agent.name,
      elo: agent.elo,
      peakElo: stats.peakElo,
      wins: agent.wins,
      losses: agent.losses,
      draws: agent.draws,
      totalMatches: stats.totalMatches,
      winRate: stats.winRate,
      tier: agent.tier,
      verifiedAt: now
    }
  };
}

// ── Signing ──────────────────────────────────────────────────────────────────

/**
 * Sign a credential with our Ed25519 private key.
 *
 * Produces an Ed25519Signature2020 proof. The signature covers a SHA-256
 * hash of the canonical JSON credential (JSON.stringify with sorted keys).
 *
 * @param {object} credential - Unsigned credential
 * @returns {object} Signed credential with proof block
 */
function signCredential(credential) {
  const privateKey = loadPrivateKey();
  const created = new Date().toISOString();

  // Canonical serialization: sorted keys for deterministic hashing
  const canonical = canonicalize(credential);

  // Sign the canonical JSON bytes with Ed25519
  const signature = crypto.sign(null, Buffer.from(canonical), privateKey);
  const proofValue = 'z' + signature.toString('base64url');

  return {
    ...credential,
    proof: {
      type: 'Ed25519Signature2020',
      created,
      verificationMethod: VERIFICATION_METHOD,
      proofPurpose: 'assertionMethod',
      proofValue
    }
  };
}

/**
 * Verify a credential's Ed25519 signature.
 *
 * @param {object} signedCredential - Credential with proof block
 * @returns {{ verified: boolean, error?: string }}
 */
function verifyCredential(signedCredential) {
  try {
    const { proof, ...credential } = signedCredential;

    if (!proof || proof.type !== 'Ed25519Signature2020') {
      return { verified: false, error: 'Unsupported or missing proof type' };
    }

    if (proof.verificationMethod !== VERIFICATION_METHOD) {
      return { verified: false, error: 'Unknown verification method' };
    }

    // Load public key from DID document
    const didDoc = loadDIDDocument();
    const vm = didDoc.verificationMethod.find(
      m => m.id === proof.verificationMethod
    );
    if (!vm) {
      return { verified: false, error: 'Verification method not found in DID document' };
    }

    // Decode public key from multibase (z + base58btc of multicodec Ed25519)
    const rawPubKey = multibaseToRawKey(vm.publicKeyMultibase);
    const pubKeyObj = crypto.createPublicKey({
      key: Buffer.concat([
        // Ed25519 SPKI prefix (12 bytes)
        Buffer.from('302a300506032b6570032100', 'hex'),
        rawPubKey
      ]),
      format: 'der',
      type: 'spki'
    });

    // Decode signature from base64url (strip leading 'z')
    const proofValueRaw = proof.proofValue;
    if (!proofValueRaw || !proofValueRaw.startsWith('z')) {
      return { verified: false, error: 'Invalid proofValue encoding' };
    }
    const signature = Buffer.from(proofValueRaw.slice(1), 'base64url');

    // Re-canonicalize the credential (without proof) and verify
    const canonical = canonicalize(credential);
    const valid = crypto.verify(null, Buffer.from(canonical), pubKeyObj, signature);

    return { verified: valid, error: valid ? undefined : 'Signature verification failed' };
  } catch (err) {
    return { verified: false, error: err.message };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deterministic JSON serialization with recursively sorted keys (RFC 8785 subset).
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(v => canonicalize(v)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

/**
 * Decode multibase (base58btc, 'z' prefix) to raw 32-byte Ed25519 public key.
 * Strips the 2-byte multicodec prefix (0xed01).
 */
function multibaseToRawKey(multibase) {
  if (!multibase.startsWith('z')) {
    throw new Error('Only base58btc (z prefix) multibase supported');
  }
  const encoded = multibase.slice(1);
  const bytes = base58btcDecode(encoded);
  // Multicodec: first 2 bytes are 0xed 0x01 for Ed25519 public key
  if (bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new Error('Not an Ed25519 multicodec key');
  }
  return bytes.subarray(2); // 32-byte raw key
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE_MAP = new Uint8Array(256).fill(255);
for (let i = 0; i < ALPHABET.length; i++) BASE_MAP[ALPHABET.charCodeAt(i)] = i;

function base58btcDecode(str) {
  const bytes = [0];
  for (const char of str) {
    const val = BASE_MAP[char.charCodeAt(0)];
    if (val === 255) throw new Error(`Invalid base58 character: ${char}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1's → leading zeros
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  ISSUER_DID,
  VERIFICATION_METHOD,
  loadPrivateKey,
  loadDIDDocument,
  buildCredential,
  signCredential,
  verifyCredential,
};
