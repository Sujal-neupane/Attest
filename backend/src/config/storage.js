/**
 * Storage and link-signing, resolved once and shared by the API and the worker.
 *
 * Both processes must agree on the encryption key or the worker cannot read
 * what the API wrote — a failure that would only appear at parse time, as an
 * integrity-check error on a file that is perfectly intact. Deriving the key in
 * two places is exactly how that drift happens, so it is derived here.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const env = require('./env');
const storage = require('../services/storage');

/**
 * In production the encryption key is explicit and separate from every signing
 * secret. Reusing a JWT secret as an encryption key is a mistake that stays
 * invisible until the day one of them is rotated and every stored document
 * becomes unreadable.
 *
 * In development it is derived from the access secret so the API and worker
 * agree with no extra setup, and the derivation is namespaced so it can never
 * collide with the token signing use of the same secret.
 */
function resolveKey() {
  if (env.STORAGE_ENCRYPTION_KEY) {
    const key = Buffer.from(env.STORAGE_ENCRYPTION_KEY, 'base64');
    if (key.length !== storage.KEY_BYTES) {
      throw new Error(
        `STORAGE_ENCRYPTION_KEY must be ${storage.KEY_BYTES} bytes, base64-encoded. ` +
          `Generate one with: openssl rand -base64 32`,
      );
    }
    return key;
  }

  if (env.isProduction) {
    throw new Error('STORAGE_ENCRYPTION_KEY is required in production.');
  }

  return crypto.createHash('sha256').update(`attest:dev-storage:${env.JWT_ACCESS_SECRET}`).digest();
}

function resolveSigningSecret() {
  return (
    env.STORAGE_SIGNING_SECRET ||
    crypto.createHash('sha256').update(`attest:dev-links:${env.JWT_ACCESS_SECRET}`).digest('hex')
  );
}

let cached = null;

/** Lazily built and memoised, so requiring this module has no side effects. */
function get() {
  if (!cached) {
    const root = path.resolve(env.STORAGE_ROOT || 'uploads');
    cached = {
      store: storage.createLocalStorage({ root, key: resolveKey() }),
      signer: storage.createSigner(resolveSigningSecret()),
      root,
    };
  }
  return cached;
}

/** Tests inject their own temp-directory store; this lets them replace it. */
function override(replacement) {
  cached = replacement;
}

module.exports = { get, override };
