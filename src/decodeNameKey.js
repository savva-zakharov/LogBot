// src/decodeNameKey.js
// Helper to decode the name-keyed Logbird bundle created by /logbird
// Token format: n1:<ivB64>:<cipherB64>:<tagB64>

const crypto = require('crypto');

const SCHEME = 'n1';
const SALT = 'logbird.namekey.v1';

function b64Decode(str) {
  return Buffer.from(String(str || ''), 'base64');
}

function deriveKeyFromName(playerName) {
  const name = String(playerName || '').trim();
  if (!name) throw new Error('Empty player name');
  return crypto.scryptSync(name, SALT, 32); // 256-bit key
}

function decryptWithPlayerName(token, playerName) {
  if (typeof token !== 'string' || !token.includes(':')) {
    throw new Error('Invalid token');
  }
  const parts = token.split(':');
  if (parts.length !== 4 || parts[0] !== SCHEME) {
    throw new Error('Unsupported token format');
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const iv = b64Decode(ivB64);
  const ciphertext = b64Decode(ctB64);
  const tag = b64Decode(tagB64);
  if (iv.length !== 12) {
    throw new Error('Invalid IV');
  }
  const key = deriveKeyFromName(playerName);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const text = plain.toString('utf8');
  return JSON.parse(text);
}

// CLI usage: node src/decodeNameKey.js "Matched Player" "n1:iv:cipher:tag"
if (require.main === module) {
  const [, , playerName, token] = process.argv;
  if (!playerName || !token) {
    console.error('Usage: node src/decodeNameKey.js "<Matched Player>" "<Keyed Bundle Token>"');
    process.exit(2);
  }
  try {
    const payload = decryptWithPlayerName(token, playerName);
    // Pretty print payload
    console.log(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('Decode failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = { decryptWithPlayerName };
