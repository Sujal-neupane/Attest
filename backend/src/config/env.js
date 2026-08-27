/**
 * Environment configuration, validated once at startup.
 *
 * The process refuses to boot with a bad or missing value rather than
 * discovering it on the first request that needs it. A server that starts and
 * then fails on the tenth upload because a storage key was blank is much harder
 * to diagnose than one that never started and said why.
 */

require('dotenv').config();
const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  // 'true' / 'false'. Unset means TLS in production and plain elsewhere.
  DATABASE_SSL: z.enum(['true', 'false', '0', '1']).optional(),
  // The provider's root certificate, when you have it — turns TLS from
  // encrypted-but-unverified into properly verified.
  DATABASE_CA_CERT: z.string().optional(),

  // Signing secrets. Enforcing a real length here is worth the friction: a
  // short secret is a forgeable token, and a forgeable token in this product is
  // access to another firm's client financials.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Where encrypted documents live, and the keys that protect them.
  STORAGE_ROOT: z.string().default('uploads'),
  // 32 bytes, base64. Required in production; derived from the access secret in
  // development so the API and worker agree without extra setup.
  STORAGE_ENCRYPTION_KEY: z.string().optional(),
  // Signs short-lived document links. Separate from the token secrets so that
  // rotating one does not invalidate the other.
  STORAGE_SIGNING_SECRET: z.string().optional(),

  // 'local' writes encrypted files to disk; 's3' to any S3-compatible bucket.
  // Local is fine for one box and wrong for two — the API and worker are
  // separate processes, and on separate hosts they do not share a disk.
  STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  // MinIO and most self-hosted providers need this; AWS and R2 do not.
  STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  // Opt-in second layer, e.g. 'AES256'. Not every provider accepts it.
  STORAGE_SERVER_SIDE_ENCRYPTION: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // Written to stderr and exiting non-zero, rather than throwing: this happens
  // before any logger exists, and a stack trace here helps nobody.
  process.stderr.write(`\nInvalid environment configuration:\n\n${issues}\n\nSee .env.example.\n\n`);
  process.exit(1);
}

const env = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
});

// The two secrets must differ. If they are the same, a refresh token is a valid
// access token and the short access-token lifetime becomes decorative.
if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
  process.stderr.write(
    '\nJWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.\n' +
      'If they match, a refresh token is accepted as an access token and the\n' +
      'short access-token lifetime stops meaning anything.\n\n',
  );
  process.exit(1);
}

module.exports = env;
