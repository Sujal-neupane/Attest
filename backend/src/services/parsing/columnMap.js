/**
 * Map a bank's or a register's column headers onto the fields the engine needs.
 *
 * There is no standard. Nabil writes "Withdrawl" (sic), NIC Asia writes "Dr
 * Amount", Global IME writes "Debit", a hand-kept register in Excel writes
 * "Paid". All of them mean money out. This module holds that knowledge in one
 * place as data, so adding a new bank is a line in a table and not a new code
 * path.
 *
 * The important behaviour is what happens when it *cannot* decide: it refuses.
 * A column map guessed wrong silently produces a complete, plausible, entirely
 * incorrect set of books, which is far worse than an import that failed.
 */

/**
 * Aliases per canonical field, lowercased and stripped of punctuation before
 * comparison. Order within a field does not matter; specificity is handled by
 * scoring exact matches above partial ones.
 */
const FIELD_ALIASES = Object.freeze({
  date: [
    'date', 'txn date', 'transaction date', 'value date', 'posting date',
    'trn date', 'tran date', 'bill date', 'invoice date', 'miti',
  ],
  description: [
    'description', 'narration', 'particulars', 'details', 'remarks', 'purpose',
    'transaction details', 'transaction remarks', 'narrative', 'byapar',
  ],
  // A single signed amount column, used when there is no separate debit/credit.
  amount: ['amount', 'txn amount', 'transaction amount', 'value', 'total', 'rakam'],
  debit: [
    'debit', 'debit amount', 'dr', 'dr amount', 'withdrawal', 'withdrawl',
    'withdrawals', 'paid', 'payment', 'outflow', 'kharcha',
  ],
  credit: [
    'credit', 'credit amount', 'cr', 'cr amount', 'deposit', 'deposits',
    'received', 'receipt', 'inflow', 'aamdani',
  ],
  balance: ['balance', 'running balance', 'closing balance', 'bal', 'available balance'],
  party: [
    'party', 'party name', 'customer', 'customer name', 'supplier',
    'supplier name', 'vendor', 'client', 'name', 'account name', 'paid to',
    'received from',
  ],
  invoiceNumber: [
    'invoice no', 'invoice number', 'invoice', 'bill no', 'bill number',
    'inv no', 'inv', 'voucher no', 'voucher number', 'document no',
  ],
  reference: [
    'reference', 'ref', 'ref no', 'reference no', 'cheque no', 'cheque number',
    'chq no', 'transaction id', 'txn id', 'utr', 'instrument no',
  ],
  pan: ['pan', 'pan no', 'pan number', 'vat no', 'vat number', 'tax id'],
  taxableAmount: ['taxable amount', 'taxable value', 'net amount', 'net', 'sub total', 'subtotal'],
  vatAmount: ['vat', 'vat amount', 'tax amount', 'tax', 'vat 13', 'vat 13%'],
  grossAmount: ['gross amount', 'gross', 'total amount', 'grand total', 'bill amount'],
  quantity: ['qty', 'quantity', 'units'],
});

/** Which fields each document type genuinely cannot proceed without. */
const REQUIRED_FIELDS = Object.freeze({
  bank_statement: [['date'], ['amount', 'debit', 'credit']],
  sales_register: [['date'], ['amount', 'grossAmount', 'taxableAmount']],
  purchase_register: [['date'], ['amount', 'grossAmount', 'taxableAmount']],
});

class ColumnMapError extends Error {
  constructor(message, { header, mapped } = {}) {
    super(message);
    this.name = 'ColumnMapError';
    this.header = header;
    this.mapped = mapped;
  }
}

/**
 * @param {string[]} header raw header cells, in column order
 * @param {string} documentType key of REQUIRED_FIELDS
 * @returns {{map: Object<string,string>, unmapped: string[], notes: string[]}}
 *   `map` is canonicalField -> header label.
 */
function buildColumnMap(header, documentType) {
  const candidates = [];

  header.forEach((label) => {
    if (!label || label.trim() === '') return;
    const normalised = normalise(label);

    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      for (const alias of aliases) {
        const score = scoreMatch(normalised, alias);
        if (score > 0) candidates.push({ field, label, score, alias });
      }
    }
  });

  // Resolve greedily by score. One header maps to one field and one field takes
  // one header, so "Debit Amount" cannot end up claimed by both `debit` and
  // `amount`.
  candidates.sort((a, b) => b.score - a.score || a.field.localeCompare(b.field));

  const map = {};
  const takenLabels = new Set();
  const notes = [];

  for (const c of candidates) {
    if (map[c.field] || takenLabels.has(c.label)) continue;
    map[c.field] = c.label;
    takenLabels.add(c.label);
    if (c.score < 100) {
      notes.push(`Read column "${c.label}" as ${c.field} (matched "${c.alias}").`);
    }
  }

  const unmapped = header.filter((h) => h && h.trim() !== '' && !takenLabels.has(h));

  // A file with both a signed amount column and separate debit/credit columns
  // is ambiguous about which is authoritative. Prefer debit/credit — it is
  // unambiguous about direction, whereas a bare "Amount" column may or may not
  // carry a sign — and say so rather than deciding quietly.
  if (map.amount && map.debit && map.credit) {
    notes.push(
      `Both a combined "${map.amount}" column and separate debit/credit columns ` +
        `are present. Using debit/credit, which state direction explicitly.`,
    );
    delete map.amount;
  }

  assertRequirements(map, documentType, header);

  return { map, unmapped, notes };
}

function assertRequirements(map, documentType, header) {
  const requirements = REQUIRED_FIELDS[documentType];
  if (!requirements) {
    throw new ColumnMapError(`Unknown document type "${documentType}"`, { header });
  }

  for (const group of requirements) {
    if (group.some((field) => map[field])) continue;
    throw new ColumnMapError(
      `This file has no column that reads as ${group.join(' or ')}. ` +
        `Its columns are: ${header.filter(Boolean).join(', ')}. ` +
        `Importing it would mean guessing which column holds the money, so it ` +
        `has been rejected instead.`,
      { header, mapped: map },
    );
  }

  // A debit column without a credit column (or vice versa) is almost always a
  // detection failure rather than a real one-directional statement.
  if ((map.debit && !map.credit) || (map.credit && !map.debit)) {
    if (!map.amount) {
      throw new ColumnMapError(
        `Found a "${map.debit || map.credit}" column but no matching ` +
          `${map.debit ? 'credit' : 'debit'} column. A statement with only one ` +
          `direction is unusual enough that this is more likely a column that ` +
          `was not recognised. Columns present: ${header.filter(Boolean).join(', ')}.`,
        { header, mapped: map },
      );
    }
  }
}

/**
 * 100 = exact match, 80 = match ignoring a trailing noise word, 60 = the header
 * contains the alias as a whole word. Below that we do not match at all:
 * substring matching on short aliases like "cr" against "credit card charges"
 * is exactly how a column map ends up wrong.
 */
function scoreMatch(normalisedHeader, alias) {
  if (normalisedHeader === alias) return 100;

  const stripped = normalisedHeader
    .replace(/\b(amount|amt|value|rs|npr|in rs|nrs)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped === alias) return 80;

  // Whole-word containment, and only for aliases long enough to be meaningful.
  if (alias.length >= 4) {
    const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`);
    if (pattern.test(normalisedHeader)) return 60;
  }

  return 0;
}

function normalise(label) {
  return String(label)
    .toLowerCase()
    .replace(/[._/\\()[\]{}#:*]/g, ' ')
    .replace(/[^a-z0-9%\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  FIELD_ALIASES,
  REQUIRED_FIELDS,
  ColumnMapError,
  buildColumnMap,
  _internals: { normalise, scoreMatch },
};
