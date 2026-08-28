/**
 * Which browser origins may call this API.
 *
 * ─── WHY THIS IS NOT ONE LINE ───────────────────────────────────────────────
 *
 * It used to be `origin: env.CORS_ORIGIN.split(',')`, which is wrong in a way
 * that only shows up in a browser. The `cors` package compares the request's
 * Origin header against each entry by equality, so the conventional wildcard
 * value `*` becomes the literal string "*" and matches nothing — the response
 * carries no Access-Control-Allow-Origin at all, and every fetch from the
 * frontend fails with a CORS error that names no cause. curl never sees it,
 * because curl does not enforce CORS. Deploying the API and the frontend
 * separately is exactly when it bites.
 *
 * So `*` is handled explicitly, and a refusal is a real error with the origin
 * in it rather than a silently absent header.
 *
 * ─── ON WILDCARD SUBDOMAINS ─────────────────────────────────────────────────
 *
 * `https://*.vercel.app` is supported because preview deployments get a fresh
 * hostname per commit, and the alternative is either pinning production only
 * (previews break) or opening it to everything (nothing is protected). The
 * wildcard matches ONE label — `https://*.vercel.app` allows `attest.vercel.app`
 * but not `evil.attest.vercel.app` — and the scheme must still match, so an
 * http:// origin cannot borrow an https:// entry.
 */

/** Turn one configured entry into a predicate over an Origin header value. */
function matcherFor(entry) {
  if (!entry.includes('*')) {
    return (origin) => origin === entry;
  }

  // Escape everything, then re-open the single wildcard as one hostname label.
  const pattern = new RegExp(
    `^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '[^.]+')}$`,
  );
  return (origin) => pattern.test(origin);
}

/**
 * @param {string} configured  CORS_ORIGIN — comma-separated origins, or `*`.
 * @returns {import('cors').CorsOptions['origin']}
 */
function corsOrigin(configured) {
  const entries = String(configured)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // `*` anywhere in the list means the list is meaningless — say so rather than
  // half-applying it.
  const allowAny = entries.includes('*');
  const matchers = entries.map(matcherFor);

  return (origin, callback) => {
    // No Origin header: a server-to-server call, curl, or a same-origin
    // navigation. CORS does not apply, and refusing here would break the
    // health check.
    if (!origin) return callback(null, true);

    if (allowAny) return callback(null, true);
    if (matchers.some((match) => match(origin))) return callback(null, true);

    // Named, so the deployer can read the log and see exactly what to add.
    return callback(
      new Error(
        `Origin ${origin} is not allowed to call this API. ` +
          `Set CORS_ORIGIN to include it (currently: ${entries.join(', ') || '(empty)'}).`,
      ),
    );
  };
}

module.exports = { corsOrigin, _matcherFor: matcherFor };
