/**
 * Registration, sign-in, and token issuance.
 */

const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const env = require('../config/env');
const { withFirm } = require('../config/db');
const users = require('../repositories/user.repository');
const audit = require('../repositories/audit.repository');
const { hashPassword, verifyPassword, needsRehash } = require('../utils/password');
const { ApiError } = require('../middleware/errorHandler');

const ISSUER = 'attest';
const AUDIENCE = 'attest-api';

async function register({ firmName, email, password, fullName }, context = {}) {
  if (await users.emailExists(email)) {
    // Registration is the one place where confirming an address exists is
    // acceptable — the person is trying to create that account and needs to
    // know why it failed. Sign-in deliberately does not do this.
    throw new ApiError(409, 'An account already exists for this email address.', {
      code: 'email_taken',
    });
  }

  const passwordHash = await hashPassword(password);
  const { firm, user } = await users.createFirmWithFirstUser({
    firmName,
    email,
    passwordHash,
    fullName,
  });

  await withFirm(firm.id, (client) =>
    audit.record(client, {
      firmId: firm.id,
      userId: user.id,
      action: 'register',
      entityType: 'firm',
      entityId: firm.id,
      detail: { firmName, email },
      ip: context.ip,
      userAgent: context.userAgent,
    }),
  );

  return { firm, user, tokens: issueTokens(user) };
}

async function login({ email, password }, context = {}) {
  const user = await users.findByEmailForAuth(email);

  // The same message and the same amount of work whether the address exists or
  // not. Verifying against a dummy hash keeps the timing similar, so this
  // endpoint cannot be used to enumerate which accountants have accounts.
  const stored = user?.passwordHash || DUMMY_HASH;
  const ok = await verifyPassword(password, stored);

  if (!user || !ok || !user.isActive) {
    throw new ApiError(401, 'That email address and password do not match.', {
      code: 'invalid_credentials',
    });
  }

  await withFirm(user.firmId, async (client) => {
    await users.recordLogin(client, user.id);

    // Opportunistic upgrade: we have the plaintext exactly once, here, so this
    // is the only moment a hash made with weaker parameters can be replaced.
    if (needsRehash(user.passwordHash)) {
      await users.updatePasswordHash(client, user.id, await hashPassword(password));
    }

    await audit.record(client, {
      firmId: user.firmId,
      userId: user.id,
      action: 'login',
      entityType: 'user',
      entityId: user.id,
      detail: {},
      ip: context.ip,
      userAgent: context.userAgent,
    });
  });

  return { user: publicUser(user), tokens: issueTokens(user) };
}

function refresh(refreshToken) {
  let payload;
  try {
    payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch {
    throw new ApiError(401, 'Your session has expired. Please sign in again.', {
      code: 'refresh_invalid',
    });
  }

  if (payload.typ !== 'refresh') {
    throw new ApiError(401, 'Invalid session.', { code: 'wrong_token_type' });
  }

  return issueTokens({
    id: payload.sub,
    firmId: payload.firmId,
    role: payload.role,
    email: payload.email,
  });
}

/**
 * Access tokens are short-lived and carry the firm and role; refresh tokens are
 * long-lived and carry the minimum needed to mint a new pair. `typ` separates
 * them so one can never be presented as the other.
 */
function issueTokens(user) {
  const base = {
    firmId: user.firmId,
    role: user.role,
    email: user.email,
  };
  const options = {
    issuer: ISSUER,
    audience: AUDIENCE,
    subject: user.id,
    algorithm: 'HS256',
    jwtid: crypto.randomUUID(),
  };

  return {
    accessToken: jwt.sign({ ...base, typ: 'access' }, env.JWT_ACCESS_SECRET, {
      ...options,
      expiresIn: env.ACCESS_TOKEN_TTL,
    }),
    refreshToken: jwt.sign({ ...base, typ: 'refresh' }, env.JWT_REFRESH_SECRET, {
      ...options,
      expiresIn: env.REFRESH_TOKEN_TTL,
    }),
    tokenType: 'Bearer',
  };
}

function publicUser(user) {
  return {
    id: user.id,
    firmId: user.firmId,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
  };
}

/**
 * A real scrypt hash of a value nobody knows, used only to spend comparable
 * time when the email address does not exist.
 */
const DUMMY_HASH =
  'scrypt$131072$8$1$YWJjZGVmZ2hpamtsbW5vcA==$' +
  'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4';

module.exports = { register, login, refresh, issueTokens, publicUser };
