/**
 * Password hashing.
 *
 * Uses scrypt from Node's standard library rather than argon2id. argon2id is
 * the better choice on the merits and is what this should use in production —
 * but it needs a native build, and a dependency that fails to compile on a
 * deploy host is a worse outcome than a slightly less modern KDF that is
 * already present and audited. scrypt is memory-hard, is in the standard
 * library, and is explicitly acceptable for password storage.
 *
 * The stored format carries its own parameters, so raising the cost later does
 * not invalidate existing hashes: old hashes keep verifying with the parameters
 * they were made with, and `needsRehash()` says when to upgrade one on the next
 * successful login.
 *
 * In production the intent is for Supabase Auth to own credentials entirely,
 * at which point this module is only used for local development and seeding.
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

/** OWASP's floor for scrypt at the time of writing: N=2^17, r=8, p=1. */
const PARAMS = Object.freeze({ N: 2 ** 17, r: 8, p: 1, keylen: 64, saltBytes: 16 });

const PREFIX = 'scrypt';

async function hashPassword(plain) {
  assertUsable(plain);
  const salt = crypto.randomBytes(PARAMS.saltBytes);
  const key = await scrypt(plain.normalize('NFKC'), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    // Node's default maxmem is too small for N=2^17 and throws without this.
    maxmem: 256 * 1024 * 1024,
  });
  return [
    PREFIX,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed hash rather than throwing, so a corrupted row
 * fails a login instead of taking down the endpoint — and the comparison is
 * always constant-time, so this does not become a way to learn which accounts
 * exist by timing it.
 */
async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const [, N, r, p, saltB64, keyB64] = parts;
  let expected;
  try {
    expected = Buffer.from(keyB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');
    const actual = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with weaker parameters than we now use. */
function needsRehash(stored) {
  if (typeof stored !== 'string') return true;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return true;
  return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r;
}

function assertUsable(plain) {
  if (typeof plain !== 'string' || plain.length < 12) {
    throw new Error('Password must be at least 12 characters.');
  }
  // bcrypt's 72-byte truncation does not apply to scrypt, but an unbounded
  // password is a cheap denial-of-service: hashing a 10MB string is expensive.
  if (Buffer.byteLength(plain) > 1024) {
    throw new Error('Password must be at most 1024 bytes.');
  }
}

module.exports = { hashPassword, verifyPassword, needsRehash, PARAMS };
