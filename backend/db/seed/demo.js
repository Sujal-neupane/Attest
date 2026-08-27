/* eslint-disable no-console -- A seed script run from a terminal; stdout is
   its entire user interface. */

/**
 * Demo data.
 *
 * Run with:  npm run seed:demo
 *
 * A live URL that opens onto an empty dashboard demonstrates nothing. This
 * seeds a firm, a client, a Shrawan 2081 period, and two documents that go
 * through the real pipeline — parsed by the real parser, reconciled by the real
 * engine — so what a visitor sees is genuinely what the software produced, not
 * a fixture dressed up to look like output.
 *
 * The books are deliberately imperfect. Every finding below is one a real
 * accountant would want raised:
 *
 *   INV-001, INV-002   paid, and matched against the bank
 *   INV-003            unpaid — a receivable, not an error
 *   INV-004            missing from the sequence entirely
 *   INV-005            reports Rs. 1,000 VAT on Rs. 10,000 taxable: wrong by 300
 *   GURUNG HARDWARE    money left the account with no purchase bill behind it
 *   PURCHASE SUP-772   booked twice under the same bill number
 *
 * Idempotent: running it twice does not double the data.
 */

require('dotenv').config();

const crypto = require('node:crypto');
const { pool, withFirm } = require('../../src/config/db');
const storageConfig = require('../../src/config/storage');
const { hashPassword } = require('../../src/utils/password');
const { createDocumentService } = require('../../src/services/document.service');
const { runReconciliation } = require('../../src/services/review.service');
const { runOnce } = require('../../src/workers/parseDocument');
const { monthRange } = require('../../src/utils/nepaliCalendar');

const DEMO_EMAIL = 'demo@attest.np';
const DEMO_PASSWORD = 'attest-demo-account';

const BANK_STATEMENT = [
  'NABIL BANK LIMITED',
  'Statement of Account',
  'Account No: 0123456789012345',
  'Period: 16-Jul-2024 to 16-Aug-2024',
  '',
  'Date,Narration,Withdrawl,Deposit,Balance',
  '16/07/2024,OPENING BALANCE,,,"2,50,000.00"',
  '17/07/2024,IPS/FT FROM SHARMA TRADERS,,"11,300.00","2,61,300.00"',
  '18/07/2024,IPS/FT FROM EVEREST RETAIL,,"22,600.00","2,83,900.00"',
  '20/07/2024,CHQ 004521 PAID TO GURUNG HARDWARE,"5,650.00",,"2,78,250.00"',
  '22/07/2024,TRF TO KATHMANDU PAPERS,"9,040.00",,"2,69,210.00"',
  '25/07/2024,IPS/FT FROM POKHARA WHOLESALE,,"33,900.00","3,03,110.00"',
  '26/07/2024,TRF TO THAMEL STATIONERS,"5,085.00",,"2,98,025.00"',
  '30/07/2024,BANK CHARGES,"226.00",,"2,97,799.00"',
  'TOTAL,,"20,001.00","67,800.00",',
].join('\n');

const SALES_REGISTER = [
  'Date,Invoice No,Party Name,PAN,Taxable Amount,VAT',
  '17/07/2024,INV-001,Sharma Traders,123456789,"10,000.00","1,300.00"',
  '18/07/2024,INV-002,Everest Retail,987654321,"20,000.00","2,600.00"',
  '19/07/2024,INV-003,Lalitpur Stores,456789123,"15,000.00","1,950.00"',
  '25/07/2024,INV-005,Pokhara Wholesale,321654987,"30,000.00","3,900.00"',
  '28/07/2024,INV-006,Bhaktapur Supply,741852963,"10,000.00","1,000.00"',
].join('\n');

const PURCHASE_REGISTER = [
  'Bill Date,Bill No,Supplier,PAN,Taxable Value,VAT Amount',
  '22/07/2024,SUP-772,Kathmandu Papers,159357456,"8,000.00","1,040.00"',
  '22/07/2024,SUP-772,Kathmandu Papers,159357456,"8,000.00","1,040.00"',
  '26/07/2024,SUP-780,Thamel Stationers,258147369,"4,500.00","585.00"',
].join('\n');

async function seed({ log = console.log } = {}) {
  const { store } = storageConfig.get();
  const documentService = createDocumentService({ store });

  // Already seeded? Leave it alone rather than stacking a second copy.
  const { rows: existing } = await pool.query(
    'SELECT id, firm_id AS "firmId" FROM users WHERE lower(email) = $1',
    [DEMO_EMAIL],
  );
  if (existing.length > 0) {
    log('Demo data already present — nothing to do.');
    return { firmId: existing[0].firmId, created: false };
  }

  const firmId = crypto.randomUUID();
  const client = await pool.connect();
  let userId;
  let clientId;
  let periodId;

  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_firm_id', firmId]);

    await client.query('INSERT INTO firms (id, name) VALUES ($1, $2)', [
      firmId,
      'Neupane & Associates, Chartered Accountants',
    ]);

    const { rows: users } = await client.query(
      `INSERT INTO users (firm_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, 'admin') RETURNING id`,
      [firmId, DEMO_EMAIL, await hashPassword(DEMO_PASSWORD), 'Demo Accountant'],
    );
    userId = users[0].id;

    const { rows: clients } = await client.query(
      `INSERT INTO clients (firm_id, name, pan) VALUES ($1, $2, $3) RETURNING id`,
      [firmId, 'Himalayan Traders Pvt Ltd', '301234567'],
    );
    clientId = clients[0].id;

    // The Gregorian range comes from the verified calendar table, exactly as it
    // would if a firm created this period through the UI.
    const shrawan = monthRange(2081, 4);
    const { rows: periods } = await client.query(
      `INSERT INTO fiscal_periods
         (firm_id, client_id, label, bs_year, bs_month, start_date, end_date)
       VALUES ($1, $2, $3, 2081, 4, $4, $5) RETURNING id`,
      [firmId, clientId, shrawan.label, shrawan.startDate, shrawan.endDate],
    );
    periodId = periods[0].id;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const user = { id: userId, firmId, role: 'admin' };
  log(`Created firm, client and ${'Shrawan 2081'}.`);

  // Uploaded and parsed through the real pipeline, so the demo shows genuine
  // output — including the provenance that makes every figure traceable.
  const documents = [
    ['bank_statement', 'nabil-shrawan-2081.csv', BANK_STATEMENT],
    ['sales_register', 'sales-register-shrawan.csv', SALES_REGISTER],
    ['purchase_register', 'purchase-register-shrawan.csv', PURCHASE_REGISTER],
  ];

  for (const [type, filename, contents] of documents) {
    await documentService.upload(user, periodId, {
      type,
      filename,
      contents: Buffer.from(contents, 'utf8'),
    });
    log(`  uploaded ${filename}`);
  }

  // Drain the queue here rather than waiting for a worker, so the seed finishes
  // with the demo genuinely ready instead of merely queued.
  for (let i = 0; i < 10; i++) {
    const outcome = await runOnce({ store, logger: {} });
    if (outcome === null) break;
    if (!outcome.ok) log(`  ! ${filenameOf(outcome)}: ${outcome.error?.message}`);
  }

  const result = await runReconciliation(user, periodId, {});
  log(
    `  reconciled: ${result.reconciliation.matchedCount} matched, ` +
      `${result.flagsRaised} findings raised`,
  );

  const summary = await withFirm(firmId, async (db) => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS transactions FROM transactions WHERE fiscal_period_id = $1`,
      [periodId],
    );
    return rows[0];
  });

  log('');
  log('Demo ready.');
  log(`  email:    ${DEMO_EMAIL}`);
  log(`  password: ${DEMO_PASSWORD}`);
  log(`  period:   /periods/${periodId}`);
  log(`  ${summary.transactions} transactions, ${result.flagsRaised} findings`);

  return { firmId, periodId, created: true };
}

function filenameOf(outcome) {
  return outcome?.job?.payload?.documentId ?? 'document';
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(async (err) => {
      process.stderr.write(`\nSeed failed: ${err.message}\n${err.stack}\n\n`);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { seed, DEMO_EMAIL, DEMO_PASSWORD };
