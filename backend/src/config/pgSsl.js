/**
 * Whether to connect to Postgres over TLS.
 *
 * ─── WHY THIS IS NOT A HEURISTIC ────────────────────────────────────────────
 *
 * It was one. The migration runner inferred TLS from the host — anything that
 * was not localhost got it — which is right for a managed provider and wrong
 * for Postgres in a container on a private network. Under docker compose the
 * host is `postgres`, so the API turned TLS on, the database said "the server
 * does not support SSL connections", and the container exited before serving a
 * single request.
 *
 * Guessing here has two bad failure modes and no good one: guess TLS on where
 * it is unsupported and nothing starts; guess it off where it is required and
 * client financial data crosses a network in the clear. So it is declared.
 *
 *   DATABASE_SSL=true    require TLS (managed Postgres: Render, Neon, Supabase)
 *   DATABASE_SSL=false   plain (a container on a private network, or local)
 *   unset                TLS in production, plain otherwise
 *
 * The default still leans the safe way — production means TLS unless someone
 * says otherwise — but it is a documented default rather than a guess about
 * what a hostname implies.
 */

function sslFor({ databaseUrl = '', nodeEnv = process.env.NODE_ENV, explicit = process.env.DATABASE_SSL } = {}) {
  // An sslmode in the URL is the operator being specific; it wins over
  // everything, because otherwise this module would silently override it.
  const mode = /[?&]sslmode=([^&]+)/.exec(databaseUrl)?.[1];
  if (mode === 'disable') return false;
  if (mode && mode !== 'prefer') return tlsOptions();

  if (explicit === 'true' || explicit === '1') return tlsOptions();
  if (explicit === 'false' || explicit === '0') return false;

  return nodeEnv === 'production' ? tlsOptions() : false;
}

/**
 * TLS options — the certificate chain IS verified.
 *
 * This used to return `{ rejectUnauthorized: false }` by default, on the belief
 * that managed providers present a chain Node's agent rejects. That was worth
 * re-testing rather than inheriting, and against the live Neon database it is
 * simply not true: the chain verifies against Node's bundled CA store on the
 * first try. The weakness was being carried for no benefit at all.
 *
 * It is not a small weakness. Unverified TLS encrypts the connection but
 * authenticates nothing, so anything able to answer for the database host —
 * inside the provider's network, or by way of DNS — can present its own
 * certificate and read every client's financial data in the clear. Encryption
 * without verification looks identical to the real thing from the client side,
 * which is what makes it worth being deliberate about.
 *
 *   DATABASE_CA_CERT       a provider's own root, for a private CA
 *   DATABASE_SSL_INSECURE  =true to skip verification, and say so in the log
 *
 * The escape hatch exists because some self-hosted Postgres really does present
 * a self-signed certificate, and a deployment that cannot start is its own kind
 * of failure. It announces itself rather than being the quiet default.
 */
function tlsOptions() {
  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca, rejectUnauthorized: true };

  if (process.env.DATABASE_SSL_INSECURE === 'true') {
    console.warn(
      '[db] DATABASE_SSL_INSECURE=true — the database certificate is NOT being ' +
        'verified. The connection is encrypted but unauthenticated. Supply the ' +
        "provider's root in DATABASE_CA_CERT to close this.",
    );
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
}

module.exports = { sslFor };
