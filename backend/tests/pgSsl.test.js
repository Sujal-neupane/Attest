/**
 * Whether the database connection uses TLS, and whether it verifies the
 * certificate.
 *
 * Two separate questions, and the second one is the one that used to be
 * answered wrongly by default. Encryption without verification is
 * indistinguishable from the real thing at the client, so nothing about a
 * running system reveals it — which is precisely why it belongs in a test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { sslFor } = require('../src/config/pgSsl');

/** Call sslFor with a clean environment, restoring whatever was there. */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const clean = { DATABASE_CA_CERT: undefined, DATABASE_SSL_INSECURE: undefined };

test('THE CERTIFICATE IS VERIFIED BY DEFAULT', () => {
  // The whole point. This returned { rejectUnauthorized: false } for months on
  // the belief that managed providers need it — Neon does not, and the
  // weakness was being carried for nothing.
  const ssl = withEnv(clean, () => sslFor({ explicit: 'true' }));

  assert.deepEqual(ssl, { rejectUnauthorized: true });
});

test('a supplied CA is used and still verifies', () => {
  const ssl = withEnv({ ...clean, DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----' }, () =>
    sslFor({ explicit: 'true' }),
  );

  assert.equal(ssl.rejectUnauthorized, true, 'supplying a CA must not turn verification off');
  assert.equal(ssl.ca, '-----BEGIN CERTIFICATE-----');
});

test('verification can be turned off, but only deliberately and loudly', () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);

  try {
    const ssl = withEnv({ ...clean, DATABASE_SSL_INSECURE: 'true' }, () =>
      sslFor({ explicit: 'true' }),
    );
    assert.deepEqual(ssl, { rejectUnauthorized: false });
  } finally {
    console.warn = realWarn;
  }

  assert.equal(warnings.length, 1, 'skipping verification must not be silent');
  assert.match(warnings[0], /NOT being verified/);
});

test('any value other than the exact opt-in still verifies', () => {
  // 'TRUE', '1', 'yes' are someone guessing at the flag. Failing closed means
  // they get a connection error they can read, not silent weak TLS.
  for (const value of ['TRUE', '1', 'yes', '']) {
    const ssl = withEnv({ ...clean, DATABASE_SSL_INSECURE: value }, () =>
      sslFor({ explicit: 'true' }),
    );
    assert.equal(ssl.rejectUnauthorized, true, `DATABASE_SSL_INSECURE=${value} must not weaken TLS`);
  }
});

test('sslmode=disable in the URL turns TLS off entirely', () => {
  const ssl = withEnv(clean, () =>
    sslFor({ databaseUrl: 'postgres://h/db?sslmode=disable', explicit: 'true' }),
  );
  assert.equal(ssl, false);
});

test('an sslmode in the URL wins over the environment', () => {
  // The operator being specific. Overriding it here silently would be worse
  // than either answer.
  const ssl = withEnv(clean, () =>
    sslFor({ databaseUrl: 'postgres://h/db?sslmode=require', explicit: 'false' }),
  );
  assert.deepEqual(ssl, { rejectUnauthorized: true });
});

test('DATABASE_SSL=false means plain, for a container on a private network', () => {
  assert.equal(withEnv(clean, () => sslFor({ explicit: 'false' })), false);
  assert.equal(withEnv(clean, () => sslFor({ explicit: '0' })), false);
});

test('unset leans safe: TLS in production, plain otherwise', () => {
  assert.deepEqual(
    withEnv(clean, () => sslFor({ nodeEnv: 'production', explicit: undefined })),
    { rejectUnauthorized: true },
  );
  assert.equal(
    withEnv(clean, () => sslFor({ nodeEnv: 'development', explicit: undefined })),
    false,
  );
});
