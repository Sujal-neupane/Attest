/**
 * Authentication and authorization middleware.
 *
 * The one rule that matters here: `firmId` is read from the verified token and
 * from nowhere else. It is never taken from a request body, a query string, a
 * header, or a URL parameter — because all four are attacker-controlled, and
 * `withFirm()` trusts whatever it is handed.
 */

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { ApiError } = require('./errorHandler');

const ROLES = Object.freeze(['admin', 'preparer', 'reviewer']);

/**
 * Verify the bearer token and attach `req.user`.
 */
function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (!token || scheme.toLowerCase() !== 'bearer') {
    return next(new ApiError(401, 'Sign in to continue.', { code: 'missing_token' }));
  }

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'], // pinned: never let the token choose its own algorithm
      issuer: 'attest',
      audience: 'attest-api',
    });
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return next(
      new ApiError(401, expired ? 'Your session has expired.' : 'Invalid session.', {
        code: expired ? 'token_expired' : 'token_invalid',
      }),
    );
  }

  // A refresh token presented as an access token must be rejected. Without this
  // check the two are interchangeable and the short access lifetime is theatre.
  if (payload.typ !== 'access') {
    return next(new ApiError(401, 'Invalid session.', { code: 'wrong_token_type' }));
  }

  if (!payload.sub || !payload.firmId || !ROLES.includes(payload.role)) {
    return next(new ApiError(401, 'Invalid session.', { code: 'token_malformed' }));
  }

  req.user = Object.freeze({
    id: payload.sub,
    firmId: payload.firmId,
    role: payload.role,
    email: payload.email,
  });

  return next();
}

/**
 * Restrict a route to particular roles.
 *
 * Used as `requireRole('admin')`. The role comes from the token, so this cannot
 * be escalated by the client.
 */
function requireRole(...allowed) {
  const permitted = new Set(allowed);
  for (const role of permitted) {
    if (!ROLES.includes(role)) throw new Error(`Unknown role in requireRole: ${role}`);
  }

  return function checkRole(req, _res, next) {
    if (!req.user) {
      return next(new ApiError(401, 'Sign in to continue.', { code: 'missing_token' }));
    }
    if (!permitted.has(req.user.role)) {
      return next(
        new ApiError(403, 'Your role does not allow this action.', {
          code: 'insufficient_role',
          // Told plainly, because the user cannot fix it without knowing it.
          detail: `This action requires: ${[...permitted].join(' or ')}.`,
        }),
      );
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole, ROLES };
