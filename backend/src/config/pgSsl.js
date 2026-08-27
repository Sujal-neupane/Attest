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
 * Managed providers present a certificate chain Node's default agent rejects,
 * because the root is theirs rather than a public CA. The connection is still
 * encrypted; what is skipped is verifying the chain.
 *
 * That is a real, if narrow, weakness: it does not protect against an attacker
 * who can already intercept traffic inside the provider's network. It is
 * accepted because the alternative — refusing to connect at all — is worse, and
 * because DATABASE_CA_CERT closes it properly for anyone who supplies the
 * provider's root certificate.
 */
function tlsOptions() {
  const ca = process.env.DATABASE_CA_CERT;
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

module.exports = { sslFor };
