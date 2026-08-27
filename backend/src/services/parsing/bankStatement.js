/**
 * Turn a bank statement CSV into normalized transactions.
 *
 * The output of this module is what the reconciliation and tax engines consume,
 * so its contract is strict: every row either becomes a transaction with a
 * traceable `sourceRef`, or becomes an `issue` naming the row and the reason.
 * Nothing is dropped quietly. A silently skipped row is a missing expense, and
 * a missing expense is unclaimed input VAT.
 */

const { toRecords } = require('./csv');
const { buildColumnMap } = require('./columnMap');
const { parseAmount, MoneyError } = require('../../domain/money');
const {
  parseDate,
  detectDateOrder,
  looksBikramSambat,
  DateError,
  isWithin,
} = require('../../utils/dates');
const { bsToAd } = require('../../utils/nepaliCalendar');

/**
 * @param {string} text raw CSV
 * @param {object} context
 * @param {string} context.documentId
 * @param {string} [context.periodStart] ISO — rows outside are flagged, not dropped
 * @param {string} [context.periodEnd]
 * @returns {{transactions:Array, issues:Array, notes:string[], stats:object,
 *            balanceCheck:object|null}}
 */
function parseBankStatement(text, context = {}) {
  const { records, header, notes: csvNotes, skipped } = toRecords(text);
  const { map, unmapped, notes: mapNotes } = buildColumnMap(header, 'bank_statement');

  const notes = [...csvNotes, ...mapNotes];
  const issues = skipped.map((s) => ({
    rowNumber: s.rowNumber,
    severity: s.recovered ? 'warning' : 'info',
    reason: s.reason,
    raw: s.raw.join(' | '),
  }));

  if (unmapped.length > 0) {
    notes.push(`Columns present but not used: ${unmapped.join(', ')}.`);
  }

  // Settle day/month order once, for the whole file, from whichever row happens
  // to be unambiguous. One row reading 16/07/2024 resolves every 05/06/2024
  // elsewhere in the same export.
  const rawDates = records.map((r) => r.values[map.date]).filter(Boolean);

  // Probe the calendar before importing anything. If the export is dated in
  // Bikram Sambat then every row fails for the same reason, and one file-level
  // explanation is worth more to the accountant than five hundred identical
  // row errors.
  const bsDate = rawDates.find(looksBikramSambat);
  if (bsDate) {
    const parsed = parseDate(bsDate);
    bsToAd(parsed); // throws, with the explanation the accountant needs
  }

  const order = detectDateOrder(rawDates);

  if (order.conflict) {
    throw new DateError(
      `This file contains both "${order.dmyEvidence}" and "${order.mdyEvidence}", ` +
        `which cannot both be right — one is day-first and the other month-first. ` +
        `The export is internally inconsistent and has been rejected rather than ` +
        `half-read.`,
    );
  }
  if (order.evidence) {
    notes.push(
      `Read dates as ${order.order === 'dmy' ? 'day/month/year' : 'month/day/year'}, ` +
        `settled by "${order.evidence}".`,
    );
  }

  const transactions = [];

  for (const record of records) {
    const { values, rowNumber, raw } = record;

    let iso;
    try {
      iso = readDate(values[map.date], order.order);
    } catch (err) {
      issues.push({
        rowNumber,
        severity: 'error',
        reason: err.message,
        raw: raw.join(' | '),
      });
      continue;
    }

    let amountPaisa;
    try {
      amountPaisa = readAmount(values, map);
    } catch (err) {
      issues.push({
        rowNumber,
        severity: 'error',
        reason: err.message,
        raw: raw.join(' | '),
      });
      continue;
    }

    // A zero-amount row is not an error, but it is never a real transaction
    // either — it is usually a formatting artefact or a cancelled entry.
    if (amountPaisa === 0) {
      issues.push({
        rowNumber,
        severity: 'info',
        reason: 'Row has a zero amount and was not imported as a transaction.',
        raw: raw.join(' | '),
      });
      continue;
    }

    const description = (values[map.description] || '').trim();

    const txn = {
      documentId: context.documentId ?? null,
      source: 'bank',
      txnDate: iso,
      description,
      party: (values[map.party] || '').trim() || inferParty(description) || null,
      invoiceNumber: (values[map.invoiceNumber] || '').trim() || null,
      reference: (values[map.reference] || '').trim() || null,
      amountPaisa,
      direction: amountPaisa < 0 ? 'debit' : 'credit',
      kind: amountPaisa < 0 ? 'payment' : 'receipt',

      // PROVENANCE. Every figure on screen can be traced back to the line it
      // came from, and `raw` keeps the text exactly as the bank wrote it so a
      // parsing dispute can be settled against the original.
      sourceRef: {
        row: rowNumber,
        columns: map,
        raw: Object.fromEntries(
          Object.entries(map)
            .filter(([, label]) => values[label] !== undefined)
            .map(([field, label]) => [field, values[label]]),
        ),
      },
    };

    if (context.periodStart && context.periodEnd && !isWithin(iso, context.periodStart, context.periodEnd)) {
      issues.push({
        rowNumber,
        severity: 'warning',
        reason:
          `Transaction dated ${iso} falls outside the period ` +
          `${context.periodStart} to ${context.periodEnd}. It was imported, but ` +
          `it will not appear in this period's VAT summary.`,
        raw: raw.join(' | '),
      });
      txn.outsidePeriod = true;
    }

    transactions.push(txn);
  }

  const balanceCheck = map.balance
    ? verifyRunningBalance(records, map)
    : null;

  if (balanceCheck && !balanceCheck.consistent) {
    notes.push(
      `The statement's own running balance does not reconcile at ` +
        `${balanceCheck.breaks.length} point(s). This usually means rows are ` +
        `missing from the export rather than that the parse is wrong.`,
    );
  } else if (balanceCheck) {
    notes.push(
      `Verified against the statement's own running balance across all ` +
        `${balanceCheck.checked} rows — the import is complete.`,
    );
  }

  return {
    transactions,
    issues,
    notes,
    balanceCheck,
    stats: {
      rowsRead: records.length,
      imported: transactions.length,
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      debits: transactions.filter((t) => t.direction === 'debit').length,
      credits: transactions.filter((t) => t.direction === 'credit').length,
    },
  };
}

function readDate(rawDate, dayFirst) {
  const parsed = parseDate(rawDate, { dayFirst });
  if (parsed.calendar === 'BS') {
    // Throws with an explanation; see utils/nepaliCalendar.js for why this
    // refuses rather than approximating.
    return bsToAd(parsed);
  }
  return parsed.iso;
}

/**
 * Read the signed amount, from either a debit/credit pair or a single column.
 *
 * Sign convention, applied here once and enforced by a database constraint
 * later: money out is negative.
 */
function readAmount(values, map) {
  if (map.debit || map.credit) {
    const debitRaw = map.debit ? values[map.debit] : '';
    const creditRaw = map.credit ? values[map.credit] : '';

    const debit = isBlank(debitRaw) ? null : parseAmount(debitRaw);
    const credit = isBlank(creditRaw) ? null : parseAmount(creditRaw);

    if (debit !== null && credit !== null && debit !== 0 && credit !== 0) {
      throw new MoneyError(
        `Row has both a debit (${debitRaw}) and a credit (${creditRaw}). ` +
          `A single transaction cannot be both, so the row was not imported.`,
      );
    }
    if (debit !== null && debit !== 0) return -Math.abs(debit);
    if (credit !== null && credit !== 0) return Math.abs(credit);
    return 0;
  }

  const raw = values[map.amount];
  if (isBlank(raw)) {
    throw new MoneyError('Row has no amount.');
  }
  return parseAmount(raw);
}

/**
 * Check the statement against its own running balance.
 *
 * This is the highest-value check in the whole importer and it is nearly free.
 * If every row's balance equals the previous balance plus that row's amount,
 * then the import has read every row, read every amount correctly, and read
 * every sign correctly — verified against a figure the bank computed
 * independently. Nothing else available at import time proves completeness.
 *
 * A break points at a *missing row* far more often than at a misparse, which is
 * exactly the failure an accountant needs told: the export is short.
 */
function verifyRunningBalance(records, map) {
  const breaks = [];
  let previous = null;
  let checked = 0;

  for (const record of records) {
    const rawBalance = record.values[map.balance];
    if (isBlank(rawBalance)) continue;

    let balance;
    try {
      balance = parseAmount(rawBalance);
    } catch {
      continue;
    }

    let amount;
    try {
      amount = readAmount(record.values, map);
    } catch {
      previous = balance;
      continue;
    }

    if (previous !== null) {
      const expected = previous + amount;
      if (expected !== balance) {
        breaks.push({
          rowNumber: record.rowNumber,
          expectedPaisa: expected,
          actualPaisa: balance,
          differencePaisa: balance - expected,
        });
      }
      checked++;
    }
    previous = balance;
  }

  return {
    consistent: breaks.length === 0,
    checked,
    breaks,
    closingBalancePaisa: previous,
  };
}

/**
 * Pull a counterparty out of a bank narration.
 *
 * Narrations follow rough conventions: "TRF TO SHARMA TRADERS",
 * "IPS/FT FROM GURUNG HARDWARE", "ATM WDL KATHMANDU". This is a best effort and
 * the result is a *suggestion* — party is nullable, and reconciliation falls
 * back to the full description when it is absent, so a wrong guess here costs
 * nothing.
 */
function inferParty(description) {
  if (!description) return null;
  const match = description.match(
    /\b(?:to|from|paid to|received from|trf to|trf from|payment to)\b[:\s]+(.+)$/i,
  );
  if (!match) return null;
  return match[1]
    .replace(/\b(a\/c|ac|acct|account)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || null;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '' ||
    /^(-|n\/?a|nil)$/i.test(String(value).trim());
}

module.exports = {
  parseBankStatement,
  _internals: { readAmount, verifyRunningBalance, inferParty },
};
