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
const { createS3Storage } = require('../services/storage/s3');
const { createPostgresStorage } = require('../services/storage/postgres');

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
  if (cached) return cached;

  const key = resolveKey();
  const signer = storage.createSigner(resolveSigningSecret());

  if (env.STORAGE_BACKEND === 'postgres') {
    cached = {
      store: createPostgresStorage({
        encrypt: storage._internals.encrypt,
        decrypt: storage._internals.decrypt,
        key,
      }),
      signer,
      backend: 'postgres',
    };
    return cached;
  }

  if (env.STORAGE_BACKEND === 's3') {
    // Missing configuration throws here, at startup, rather than on the first
    // upload — which would be after the service reported itself healthy.
    cached = {
      store: createS3Storage(
        {
          bucket: env.STORAGE_BUCKET,
          endpoint: env.STORAGE_ENDPOINT,
          region: env.STORAGE_REGION,
          accessKeyId: env.STORAGE_ACCESS_KEY_ID,
          secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
          forcePathStyle: env.STORAGE_FORCE_PATH_STYLE === 'true',
          serverSideEncryption: env.STORAGE_SERVER_SIDE_ENCRYPTION,
        },
        {
          encrypt: storage._internals.encrypt,
          decrypt: storage._internals.decrypt,
          key,
        },
      ),
      signer,
      backend: 's3',
    };
    return cached;
  }

  const root = path.resolve(env.STORAGE_ROOT || 'uploads');
  cached = {
    store: storage.createLocalStorage({ root, key }),
    signer,
    root,
    backend: 'local',
  };
  return cached;
}

/** Tests inject their own temp-directory store; this lets them replace it. */
function override(replacement) {
  cached = replacement;
}

module.exports = { get, override };
