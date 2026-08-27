/**
 * Turn a sales or purchase register into normalized ledger transactions.
 *
 * A register is the client's own book: what they invoiced, and what they were
 * billed. It is the other half of reconciliation — the bank says money moved,
 * the register says why.
 *
 * Same contract as the bank importer: every row becomes a transaction with a
 * traceable `sourceRef`, or an issue naming the row and the reason. Nothing is
 * dropped quietly.
 *
 * ─── THE VAT DECISION THIS MODULE MAKES, AND THE ONE IT REFUSES TO ──────────
 *
 * Registers state amounts inconsistently: some carry taxable value and VAT in
 * separate columns, some carry only a gross total, some only a net figure. This
 * module works out WHICH of those a row is, from the columns present — that is
 * a parsing decision and it is made here.
 *
 * It does not compute VAT. Where a register supplies its own VAT figure, that
 * figure is kept as reported and the row is marked for the tax engine to check
 * against, because a discrepancy between what the client wrote and what the law
 * says is a finding for the accountant, not something to silently overwrite.
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
const { bsToAd, adToBs, SUPPORTED_RANGE } = require('../../utils/nepaliCalendar');

/**
 * @param {string} text raw CSV
 * @param {'sales_register'|'purchase_register'} documentType
 * @param {object} context { documentId, periodStart, periodEnd }
 */
function parseRegister(text, documentType, context = {}) {
  if (documentType !== 'sales_register' && documentType !== 'purchase_register') {
    throw new Error(`parseRegister called with ${documentType}`);
  }

  const isSale = documentType === 'sales_register';
  const { records, header, notes: csvNotes, skipped } = toRecords(text);
  const { map, unmapped, notes: mapNotes } = buildColumnMap(header, documentType);

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

  const rawDates = records.map((r) => r.values[map.date]).filter(Boolean);

  const bsDate = rawDates.find(looksBikramSambat);
  if (bsDate) {
    notes.push(
      `Dates in this register are in Bikram Sambat (e.g. "${bsDate}") and were ` +
        `converted to Gregorian using the verified calendar table ` +
        `(BS ${SUPPORTED_RANGE.firstYear}–${SUPPORTED_RANGE.lastYear}).`,
    );
  }

  const order = detectDateOrder(rawDates);
  if (order.conflict) {
    throw new DateError(
      `This register contains both "${order.dmyEvidence}" and "${order.mdyEvidence}", ` +
        `which cannot both be right — one is day-first and the other month-first. ` +
        `It has been rejected rather than half-read.`,
    );
  }
  if (order.evidence) {
    notes.push(
      `Read dates as ${order.order === 'dmy' ? 'day/month/year' : 'month/day/year'}, ` +
        `settled by "${order.evidence}".`,
    );
  }

  const shape = describeAmountShape(map);
  notes.push(shape.note);

  const transactions = [];

  for (const record of records) {
    const { values, rowNumber, raw } = record;

    let iso;
    try {
      const parsed = parseDate(values[map.date], { dayFirst: order.order });
      iso = parsed.calendar === 'BS' ? bsToAd(parsed) : parsed.iso;
    } catch (err) {
      issues.push({ rowNumber, severity: 'error', reason: err.message, raw: raw.join(' | ') });
      continue;
    }

    let amounts;
    try {
      amounts = readAmounts(values, map, shape);
    } catch (err) {
      issues.push({ rowNumber, severity: 'error', reason: err.message, raw: raw.join(' | ') });
      continue;
    }

    if (amounts.grossPaisa === 0) {
      issues.push({
        rowNumber,
        severity: 'info',
        reason: 'Row has a zero amount and was not imported as a transaction.',
        raw: raw.join(' | '),
      });
      continue;
    }

    // Sign convention, identical to the bank side so the two can be compared:
    // a sale brings money in (positive), a purchase sends it out (negative).
    const signedGross = isSale ? Math.abs(amounts.grossPaisa) : -Math.abs(amounts.grossPaisa);

    const invoiceNumber = (values[map.invoiceNumber] || '').trim() || null;

    if (isSale && !invoiceNumber) {
      // Sales invoices must be numbered — the sequence is what the invoice-gap
      // rule checks, and a missing number is itself a compliance problem.
      issues.push({
        rowNumber,
        severity: 'warning',
        reason: 'Sales row has no invoice number, so it cannot be checked for sequence gaps.',
        raw: raw.join(' | '),
      });
    }

    transactions.push({
      documentId: context.documentId ?? null,
      source: 'ledger',
      kind: isSale ? 'sale' : 'purchase',
      txnDate: iso,
      description: (values[map.description] || '').trim(),
      party: (values[map.party] || '').trim() || null,
      invoiceNumber,
      reference: (values[map.reference] || '').trim() || null,

      amountPaisa: signedGross,
      direction: signedGross < 0 ? 'debit' : 'credit',

      // Reported by the client, not computed. tax.js checks these rather than
      // trusting them, and a mismatch becomes a flag.
      reportedNetPaisa: amounts.netPaisa,
      reportedVatPaisa: amounts.vatPaisa,
      vatApplicable: amounts.vatApplicable,

      partyPan: (values[map.pan] || '').trim() || null,
      bsDate: bsDate ? adToBs(iso).label : null,

      sourceRef: {
        row: rowNumber,
        columns: map,
        amountShape: shape.kind,
        raw: Object.fromEntries(
          Object.entries(map)
            .filter(([, label]) => values[label] !== undefined)
            .map(([field, label]) => [field, values[label]]),
        ),
      },
    });
  }

  if (context.periodStart && context.periodEnd) {
    for (const txn of transactions) {
      if (!isWithin(txn.txnDate, context.periodStart, context.periodEnd)) {
        txn.outsidePeriod = true;
        issues.push({
          rowNumber: txn.sourceRef.row,
          severity: 'warning',
          reason:
            `Entry dated ${txn.txnDate} falls outside the period ` +
            `${context.periodStart} to ${context.periodEnd}. It was imported, but ` +
            `it will not appear in this period's VAT summary.`,
          raw: '',
        });
      }
    }
  }

  return {
    transactions,
    issues,
    notes,
    stats: {
      rowsRead: records.length,
      imported: transactions.length,
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      kind: isSale ? 'sale' : 'purchase',
    },
  };
}

/**
 * Work out how this register states its amounts, once, from the header.
 *
 * Deciding per row would let one file be read three different ways, and the
 * totals would not add up to anything the client recognises.
 */
function describeAmountShape(map) {
  if (map.taxableAmount && map.vatAmount) {
    return {
      kind: 'net_plus_vat',
      note: 'Register states taxable value and VAT separately; both were read as reported.',
    };
  }
  if (map.grossAmount && map.vatAmount) {
    return {
      kind: 'gross_less_vat',
      note: 'Register states a gross total and a VAT amount; the net was derived from the two.',
    };
  }
  if (map.taxableAmount) {
    return {
      kind: 'net_only',
      note: 'Register states taxable value only; VAT will be computed by the tax engine.',
    };
  }
  if (map.grossAmount || map.amount) {
    return {
      kind: 'gross_only',
      note:
        'Register states a single total with no VAT column. It is treated as ' +
        'VAT-inclusive, which the accountant should confirm against a sample bill.',
    };
  }
  // buildColumnMap already refuses a register with no amount column at all, so
  // reaching here means the requirements and this function have drifted apart.
  throw new Error('No amount column survived column mapping — requirements are inconsistent.');
}

function readAmounts(values, map, shape) {
  const read = (field) => {
    const raw = values[map[field]];
    if (isBlank(raw)) return null;
    return Math.abs(parseAmount(raw));
  };

  switch (shape.kind) {
    case 'net_plus_vat': {
      const netPaisa = read('taxableAmount');
      const vatPaisa = read('vatAmount') ?? 0;
      if (netPaisa === null) throw new MoneyError('Row has no taxable amount.');
      return {
        netPaisa,
        vatPaisa,
        grossPaisa: netPaisa + vatPaisa,
        vatApplicable: vatPaisa > 0,
      };
    }
    case 'gross_less_vat': {
      const grossPaisa = read('grossAmount');
      const vatPaisa = read('vatAmount') ?? 0;
      if (grossPaisa === null) throw new MoneyError('Row has no gross amount.');
      if (vatPaisa > grossPaisa) {
        throw new MoneyError(
          `Row states VAT (${values[map.vatAmount]}) larger than its gross total ` +
            `(${values[map.grossAmount]}), which cannot be right.`,
        );
      }
      return {
        netPaisa: grossPaisa - vatPaisa,
        vatPaisa,
        grossPaisa,
        vatApplicable: vatPaisa > 0,
      };
    }
    case 'net_only': {
      const netPaisa = read('taxableAmount');
      if (netPaisa === null) throw new MoneyError('Row has no taxable amount.');
      return { netPaisa, vatPaisa: null, grossPaisa: netPaisa, vatApplicable: true };
    }
    case 'gross_only':
    default: {
      const grossPaisa = read('grossAmount') ?? read('amount');
      if (grossPaisa === null) throw new MoneyError('Row has no amount.');
      // Net and VAT are left null deliberately: the tax engine splits a
      // VAT-inclusive total, and it is the only thing allowed to do that.
      return { netPaisa: null, vatPaisa: null, grossPaisa, vatApplicable: true };
    }
  }
}

function isBlank(value) {
  return (
    value === undefined ||
    value === null ||
    String(value).trim() === '' ||
    /^(-|n\/?a|nil)$/i.test(String(value).trim())
  );
}

module.exports = { parseRegister, _internals: { describeAmountShape, readAmounts } };
