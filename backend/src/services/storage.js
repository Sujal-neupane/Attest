/**
 * Document storage.
 *
 * Client financial documents are encrypted at rest with AES-256-GCM and are
 * never reachable by a plain URL — access goes through a short-lived signed
 * token that the API mints per request.
 *
 * Two backends behind one interface:
 *   * `local`  — encrypted files on disk. Development and CI.
 *   * `s3`     — an S3-compatible bucket. Production. Not wired yet; the
 *                interface exists so wiring it does not disturb the pipeline.
 *
 * ─── WHY ENCRYPT ON DISK IN DEVELOPMENT AT ALL ──────────────────────────────
 *
 * Because the alternative is a folder of real client bank statements sitting in
 * plaintext on a laptop, and because an encryption path that is only exercised
 * in production is an encryption path nobody has tested. Same code, both
 * environments.
 *
 * GCM rather than CBC: it authenticates as well as encrypts, so a file that has
 * been altered on disk fails to decrypt instead of returning corrupted data
 * that then gets parsed into transactions.
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;
const KEY_BYTES = 32;

class StorageError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'StorageError';
    if (cause) this.cause = cause;
  }
}

/**
 * Stored file layout:  [ 12-byte IV ][ 16-byte auth tag ][ ciphertext ]
 * The IV is random per file and stored alongside it, which is correct — an IV
 * is not a secret, it only has to be unique. Reusing one under the same key is
 * what breaks GCM, so it is never derived from anything predictable.
 */
function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(stored, key) {
  if (stored.length < IV_BYTES + TAG_BYTES) {
    throw new StorageError('Stored file is too short to be valid — it is truncated.');
  }
  const iv = stored.subarray(0, IV_BYTES);
  const tag = stored.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = stored.subarray(IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    // GCM's authentication failing means the file or the key is wrong. Both are
    // serious, and neither should be papered over with a partial read.
    throw new StorageError(
      'This document failed its integrity check. It has been altered on disk, ' +
        'or the encryption key has changed since it was stored.',
      { cause: err },
    );
  }
}

/**
 * Storage keys are opaque and carry no client data.
 *
 * Deliberately not derived from the filename: keys end up in logs, error
 * messages and object listings, and "Ram Bahadur bank statement Shrawan.pdf"
 * in a log line is a client-confidentiality leak. The firm and period are in
 * the path only as ids.
 */
function buildKey({ firmId, fiscalPeriodId, documentId }) {
  return `${firmId}/${fiscalPeriodId}/${documentId}`;
}

function createLocalStorage({ root, key }) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new StorageError(`Storage key must be ${KEY_BYTES} bytes.`);
  }

  const resolveSafe = (storageKey) => {
    const target = path.resolve(root, storageKey);
    // A storage key is built by us, never by a user — but path traversal is
    // cheap to rule out and catastrophic to miss, so it is ruled out here
    // rather than assumed at every call site.
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new StorageError(`Refusing to access a path outside the store: ${storageKey}`);
    }
    return target;
  };

  return {
    backend: 'local',

    async put(storageKey, contents) {
      const target = resolveSafe(storageKey);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const payload = encrypt(Buffer.from(contents), key);
      // Written to a temporary name and renamed, so a crash mid-write leaves
      // the previous file intact rather than a half-encrypted one that fails
      // its auth tag later.
      const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(temp, payload, { mode: 0o600 });
      await fs.rename(temp, target);
      return { storageKey, byteSize: payload.length };
    },

    async get(storageKey) {
      let stored;
      try {
        stored = await fs.readFile(resolveSafe(storageKey));
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new StorageError('That document is no longer in storage.', { cause: err });
        }
        throw err;
      }
      return decrypt(stored, key);
    },

    async exists(storageKey) {
      try {
        await fs.access(resolveSafe(storageKey));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Mint and verify short-lived access tokens for a stored document.
 *
 * The token is an HMAC over the storage key and an expiry, so it cannot be
 * altered to point at a different document or to last longer. It is checked in
 * constant time, and expiry is reported separately from a bad signature only
 * because those are genuinely different problems for the user — an expired link
 * means "click again", a bad signature means something is wrong.
 */
function createSigner(secret) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, 'utf8');

  return {
    sign(storageKey, { ttlSeconds = 300, now = Date.now() } = {}) {
      const expiresAt = Math.floor(now / 1000) + ttlSeconds;
      const signature = hmac(key, `${storageKey}:${expiresAt}`);
      return { token: `${expiresAt}.${signature}`, expiresAt };
    },

    verify(storageKey, token, { now = Date.now() } = {}) {
      if (typeof token !== 'string' || !token.includes('.')) {
        return { valid: false, reason: 'malformed' };
      }
      const [expiresRaw, signature] = token.split('.');
      const expiresAt = Number(expiresRaw);
      if (!Number.isInteger(expiresAt)) return { valid: false, reason: 'malformed' };

      const expected = hmac(key, `${storageKey}:${expiresAt}`);
      const a = Buffer.from(signature || '', 'hex');
      const b = Buffer.from(expected, 'hex');
      // Length check first: timingSafeEqual throws on a length mismatch, and
      // that throw would itself be a timing signal.
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { valid: false, reason: 'signature' };
      }
      if (expiresAt < Math.floor(now / 1000)) return { valid: false, reason: 'expired' };
      return { valid: true };
    },
  };
}

function hmac(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

/** sha256 of the original bytes, used to spot the same file uploaded twice. */
function contentHash(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

module.exports = {
  StorageError,
  KEY_BYTES,
  createLocalStorage,
  createSigner,
  buildKey,
  contentHash,
  _internals: { encrypt, decrypt },
};
