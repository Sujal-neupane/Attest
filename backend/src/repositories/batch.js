/**
 * Multi-row INSERT helper that respects Postgres's parameter ceiling.
 *
 * ─── THE LIMIT, AND WHY IT MATTERS HERE ─────────────────────────────────────
 *
 * The wire protocol carries the number of bind parameters as a signed 16-bit
 * integer, so a single statement can take at most 65,535 of them. A multi-row
 * INSERT uses one parameter per column per row, which makes the real limit
 * `floor(65535 / columns)` rows — and with the 19 columns a transaction has,
 * that is 3,448.
 *
 * A year of a busy retailer's bank statement is comfortably past that. Before
 * this helper existed, such an upload failed with
 * "bind message has 29464 parameter formats but 0 parameters", which the
 * accountant would have seen as a document stuck in 'failed' the week a return
 * was due, with a message nobody could act on.
 *
 * A margin is left below the hard ceiling so that adding a column to a table
 * does not silently move the boundary back under an existing caller.
 */

const MAX_BIND_PARAMETERS = 65535;
const SAFETY_MARGIN = 0.9;

/**
 * @param {import('pg').PoolClient} client
 * @param {object} spec
 * @param {string} spec.table
 * @param {string[]} spec.columns          column names, in order
 * @param {Array<object>} spec.rows
 * @param {(row: object) => Array} spec.toValues  one row -> its values, same order
 * @param {string} [spec.returning]        columns to return
 * @param {string} [spec.conflict]         a full ON CONFLICT clause, if any
 * @returns {Promise<Array>} the RETURNING rows, in input order
 */
async function insertMany(client, { table, columns, rows, toValues, returning = 'id', conflict = '' }) {
  if (rows.length === 0) return [];

  const perBatch = Math.max(
    1,
    Math.floor((MAX_BIND_PARAMETERS * SAFETY_MARGIN) / columns.length),
  );

  const inserted = [];

  // Sequential rather than parallel on purpose: these run inside the caller's
  // transaction, and a single pg client cannot have two queries in flight. It
  // is also the ordering that makes the RETURNING rows line up with the input.
  for (let start = 0; start < rows.length; start += perBatch) {
    const batch = rows.slice(start, start + perBatch);

    const values = [];
    const placeholders = batch.map((row, i) => {
      const base = i * columns.length;
      values.push(...toValues(row));
      return `(${columns.map((_, c) => `$${base + c + 1}`).join(', ')})`;
    });

    const { rows: out } = await client.query(
      `INSERT INTO ${table} (${columns.join(', ')})
       VALUES ${placeholders.join(', ')}
       ${conflict}
       RETURNING ${returning}`,
      values,
    );
    inserted.push(...out);
  }

  return inserted;
}

module.exports = { insertMany, MAX_BIND_PARAMETERS };
