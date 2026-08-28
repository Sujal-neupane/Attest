/**
 * Document storage in Postgres.
 *
 * Same interface as the local and S3 backends — put, get, exists, remove — so
 * nothing upstream knows which one it holds. See migration 006 for why this
 * exists and what it costs.
 *
 * ─── HOW THE FIRM IS KNOWN ──────────────────────────────────────────────────
 *
 * Every other query in the system runs inside withFirm(), which sets the firm
 * from the verified token. The storage interface has no firm argument — it
 * takes a key and returns bytes — so the firm is recovered from the key itself.
 *
 * That is safe only because storage keys are built by buildKey() from ids the
 * application controls, never from anything a user supplies, and the format is
 * `firmId/periodId/documentId`. The uuid is validated rather than trusted, and
 * a key that does not match the shape is refused outright: a malformed key
 * reaching this layer means something upstream is wrong, and guessing at it
 * would be the worst possible response.
 */

const { withFirm } = require('../../config/db');

class PostgresStorageError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'PostgresStorageError';
    if (cause) this.cause = cause;
  }
}

const KEY_SHAPE = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i;

function firmFromKey(storageKey) {
  const match = KEY_SHAPE.exec(String(storageKey));
  if (!match) {
    throw new PostgresStorageError(
      `Refusing a storage key that is not firm/period/document: ${storageKey}`,
    );
  }
  return match[1];
}

/**
 * @param {object} deps
 * @param {Function} deps.encrypt  (plaintext, key) -> Buffer
 * @param {Function} deps.decrypt  (stored, key) -> Buffer
 * @param {Buffer} deps.key
 */
function createPostgresStorage({ encrypt, decrypt, key }) {
  return {
    backend: 'postgres',

    async put(storageKey, contents) {
      const firmId = firmFromKey(storageKey);
      const payload = encrypt(Buffer.from(contents), key);

      await withFirm(firmId, (db) =>
        db.query(
          `INSERT INTO document_blobs (storage_key, firm_id, contents, byte_size)
           VALUES ($1, $2, $3, $4)
           -- Re-uploading the same key overwrites rather than failing. The
           -- duplicate-document check upstream is what actually prevents a
           -- double import; this is idempotency, not policy.
           ON CONFLICT (storage_key) DO UPDATE
             SET contents = EXCLUDED.contents, byte_size = EXCLUDED.byte_size`,
          [storageKey, firmId, payload, payload.length],
        ),
      );

      return { storageKey, byteSize: payload.length };
    },

    async get(storageKey) {
      const firmId = firmFromKey(storageKey);

      const row = await withFirm(firmId, async (db) => {
        const { rows } = await db.query(
          'SELECT contents FROM document_blobs WHERE storage_key = $1',
          [storageKey],
        );
        return rows[0] ?? null;
      });

      if (!row) {
        throw new PostgresStorageError('That document is no longer in storage.');
      }

      // decrypt() authenticates as it decrypts, so a row altered in the
      // database fails here rather than being parsed into transactions.
      return decrypt(Buffer.from(row.contents), key);
    },

    async exists(storageKey) {
      let firmId;
      try {
        firmId = firmFromKey(storageKey);
      } catch {
        return false;
      }

      return withFirm(firmId, async (db) => {
        const { rows } = await db.query(
          'SELECT 1 FROM document_blobs WHERE storage_key = $1',
          [storageKey],
        );
        return rows.length > 0;
      });
    },

    /**
     * Present for parity with the other backends, and never called by the
     * application — nothing in Attest deletes a financial record. The app role
     * has no DELETE grant either, so this would be refused by the database as
     * well.
     */
    async remove(storageKey) {
      const firmId = firmFromKey(storageKey);
      await withFirm(firmId, (db) =>
        db.query('DELETE FROM document_blobs WHERE storage_key = $1', [storageKey]),
      );
      return true;
    },
  };
}

module.exports = { createPostgresStorage, PostgresStorageError };
