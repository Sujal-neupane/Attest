/**
 * S3-compatible object storage.
 *
 * Same interface as the local backend — put, get, exists, remove — so nothing
 * upstream knows which one it is holding. Works against any S3-compatible
 * provider: Cloudflare R2, Backblaze B2, MinIO, Supabase Storage, AWS itself.
 *
 * ─── ENCRYPTION IS OURS, NOT THE PROVIDER'S ─────────────────────────────────
 *
 * Every object is encrypted with AES-256-GCM by this application BEFORE it is
 * uploaded, exactly as the local backend does it. Providers offer server-side
 * encryption and it is worth enabling as well, but on its own it only protects
 * against someone walking out with a disk: the provider holds the keys, so the
 * provider — and anyone who compromises the provider, or serves them a court
 * order — can read the plaintext.
 *
 * A client's bank statements should not be readable by the company renting us
 * a bucket. So the bytes that leave this process are already ciphertext, and
 * the key never does.
 *
 * ─── PATH STYLE ─────────────────────────────────────────────────────────────
 *
 * MinIO and most self-hosted providers want path-style URLs
 * (host/bucket/key); AWS and R2 prefer virtual-host style
 * (bucket.host/key). Configured explicitly rather than sniffed from the
 * endpoint, because guessing wrong produces a 404 on a bucket that plainly
 * exists, which is a genuinely confusing thing to debug.
 */

const { signRequest, encodePath } = require('./sigv4');

class S3Error extends Error {
  constructor(message, { status, code, cause } = {}) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * @param {object} config
 * @param {string} config.bucket
 * @param {string} config.endpoint         e.g. https://s3.eu-central-1.amazonaws.com
 * @param {string} config.region
 * @param {string} config.accessKeyId
 * @param {string} config.secretAccessKey
 * @param {string} [config.sessionToken]
 * @param {boolean} [config.forcePathStyle=false]
 * @param {string} [config.serverSideEncryption]  e.g. 'AES256'. Opt-in: not every
 *        S3-compatible provider accepts it, and our own encryption is the one
 *        that matters.
 * @param {object} deps
 * @param {Function} deps.encrypt          (plaintext, key) -> Buffer
 * @param {Function} deps.decrypt          (stored, key) -> Buffer
 * @param {Buffer} deps.key
 */
function createS3Storage(config, { encrypt, decrypt, key, fetchImpl = fetch, now = () => new Date() }) {
  const {
    bucket,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    forcePathStyle = false,
    serverSideEncryption,
  } = config;

  for (const [name, value] of Object.entries({ bucket, endpoint, region, accessKeyId, secretAccessKey })) {
    if (!value) throw new S3Error(`S3 storage needs ${name}.`);
  }

  const base = new URL(endpoint);

  /** Where one key lives, in whichever URL style this provider expects. */
  function locate(storageKey) {
    // A storage key is built from uuids by buildKey(), never from user input,
    // but traversal is cheap to rule out and catastrophic to miss.
    if (storageKey.includes('..') || storageKey.startsWith('/')) {
      throw new S3Error(`Refusing a suspicious storage key: ${storageKey}`);
    }

    if (forcePathStyle) {
      return {
        host: base.host,
        path: encodePath(`/${bucket}/${storageKey}`),
        url: `${base.origin}/${bucket}/${encodePath(storageKey).replace(/^\//, '')}`,
      };
    }

    const host = `${bucket}.${base.host}`;
    return {
      host,
      path: encodePath(`/${storageKey}`),
      url: `${base.protocol}//${host}/${encodePath(storageKey).replace(/^\//, '')}`,
    };
  }

  async function send(method, storageKey, { body = '', headers = {} } = {}) {
    const { host, path, url } = locate(storageKey);

    const signed = signRequest({
      method,
      host,
      path,
      body: method === 'GET' || method === 'HEAD' ? '' : body,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region,
      now: now(),
      extraHeaders: headers,
    });

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: signed.headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
      });
    } catch (cause) {
      // A network failure is not the same as a rejected request, and the
      // difference matters: one is worth retrying, the other never is.
      throw new S3Error(`Could not reach object storage at ${base.host}.`, { cause });
    }

    return response;
  }

  return {
    backend: 's3',
    bucket,

    async put(storageKey, contents) {
      const payload = encrypt(Buffer.from(contents), key);

      const response = await send('PUT', storageKey, {
        body: payload,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(payload.length),
          // Provider-side encryption is belt and braces — ours is what actually
          // protects the client, theirs protects against a stolen disk — so it
          // is OPT-IN rather than always sent.
          //
          // Sending it unconditionally broke every upload against MinIO with
          // "501 NotImplemented", because a provider without KMS configured
          // rejects the header outright. Demanding a second layer of encryption
          // so insistently that the first one never gets stored is a bad trade.
          ...(serverSideEncryption
            ? { 'x-amz-server-side-encryption': serverSideEncryption }
            : {}),
        },
      });

      if (!response.ok) {
        throw new S3Error(
          `Storing the document failed (${response.status}).`,
          { status: response.status, code: await errorCode(response) },
        );
      }

      return { storageKey, byteSize: payload.length };
    },

    async get(storageKey) {
      const response = await send('GET', storageKey);

      if (response.status === 404) {
        throw new S3Error('That document is no longer in storage.', { status: 404 });
      }
      if (!response.ok) {
        throw new S3Error(`Reading the document failed (${response.status}).`, {
          status: response.status,
          code: await errorCode(response),
        });
      }

      // decrypt() authenticates as it decrypts, so an object altered in the
      // bucket fails here rather than being parsed into transactions.
      return decrypt(Buffer.from(await response.arrayBuffer()), key);
    },

    async exists(storageKey) {
      const response = await send('HEAD', storageKey);
      return response.ok;
    },

    /**
     * Deliberately present but never called by the application.
     *
     * Nothing in Attest deletes a financial record — there is no DELETE grant
     * in the database either. This exists for operational cleanup of orphaned
     * blobs, which upload can leave behind when storage succeeds and the
     * transaction that would have recorded it does not.
     */
    async remove(storageKey) {
      const response = await send('DELETE', storageKey);
      if (!response.ok && response.status !== 404) {
        throw new S3Error(`Deleting the object failed (${response.status}).`, {
          status: response.status,
        });
      }
      return true;
    },
  };
}

/** S3 reports failures as an XML body; pull the code out for the log. */
async function errorCode(response) {
  try {
    const text = await response.text();
    return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

module.exports = { createS3Storage, S3Error };
