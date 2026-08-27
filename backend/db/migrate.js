/**
 * Apply migrations, in order, exactly once each.
 *
 * Run with:  npm run migrate
 *
 * Deployment runs this before starting the API, so a release that adds a column
 * cannot start serving before the column exists.
 *
 * Two properties matter more than anything else here:
 *
 * 1. AN ADVISORY LOCK. Two instances deploying at the same moment would
 *    otherwise both try to apply the same migration. One would fail on a
 *    duplicate object and take the deploy with it.
 *
 * 2. A RECORDED CHECKSUM. Editing a migration that has already run against
 *    production is one of the easiest ways to end up with two databases that
 *    claim the same schema version and do not have the same schema. This
 *    refuses to run if a file's contents have changed since it was applied.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

async function migrate({ databaseUrl = process.env.DATABASE_URL, log = console.log } = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations.');

  const client = new Client({
    connectionString: databaseUrl,
    // Managed Postgres (Render, Neon, Supabase) requires TLS but presents a
    // certificate chain the default agent rejects. Verified elsewhere by the
    // provider; refusing to connect at all would be worse than this.
    ssl: /localhost|127\.0\.0\.1|host=\//.test(databaseUrl)
      ? false
      : { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    await client.query(CREATE_TABLE);
    // Session-scoped, released when this connection closes.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['attest:migrations']);

    const { rows: applied } = await client.query(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const seen = new Map(applied.map((r) => [r.filename, r.checksum]));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;

    for (const filename of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      if (seen.has(filename)) {
        if (seen.get(filename) !== checksum) {
          throw new Error(
            `${filename} has changed since it was applied.\n\n` +
              `A migration that has already run is history, not source. Editing one ` +
              `leaves this database and every other claiming the same version while ` +
              `holding different schemas. Add a new migration instead.`,
          );
        }
        continue;
      }

      log(`  applying ${filename}`);
      // Each file manages its own transactions — 004 has to commit an enum
      // value before using it — so this does not wrap them in one.
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, checksum],
      );
      ran++;
    }

    log(ran === 0 ? '  already up to date' : `  applied ${ran} migration(s)`);
    return { applied: ran, total: files.length };
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  require('dotenv').config();
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`\nMigration failed:\n${err.message}\n\n`);
      process.exit(1);
    });
}

module.exports = { migrate };
