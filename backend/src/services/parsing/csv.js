/**
 * A CSV reader, written rather than installed.
 *
 * Not out of NIH: bank exports in Nepal are reliably malformed in ways a strict
 * RFC 4180 parser rejects outright — a preamble of bank branding above the real
 * header, ragged row lengths, a trailing "TOTAL" line, BOM markers from Excel,
 * CRLF mixed with LF, and semicolon or tab delimiters depending on which locale
 * the teller's machine was set to. We need to be liberal in what we accept and
 * to *report* what we had to tolerate, and that reporting is the part an
 * off-the-shelf parser does not do.
 *
 * Postel's Law, with the important half attached: liberal in what we accept,
 * but ambiguity is never silently resolved. Anything genuinely unreadable is
 * raised, not guessed at.
 */

class CsvError extends Error {
  constructor(message, { line } = {}) {
    super(message);
    this.name = 'CsvError';
    this.line = line;
  }
}

const DELIMITERS = [',', ';', '\t', '|'];

/**
 * Split raw CSV text into rows of string cells.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.delimiter] force a delimiter instead of sniffing
 * @returns {{rows: string[][], delimiter: string, notes: string[]}}
 */
function parseCsv(text, options = {}) {
  if (typeof text !== 'string') throw new CsvError('CSV input must be a string');

  const notes = [];

  // Excel on Windows writes a UTF-8 BOM, which otherwise becomes part of the
  // first header cell and quietly breaks column detection.
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    notes.push('Removed a UTF-8 byte order mark written by Excel.');
  }

  const delimiter = options.delimiter || sniffDelimiter(text);
  if (!options.delimiter && delimiter !== ',') {
    notes.push(`Detected "${describeDelimiter(delimiter)}" as the column separator.`);
  }

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        // "" inside a quoted field is a literal quote.
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line++;
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\r') {
      // Swallow; the \n that follows ends the row. A lone \r (old Mac exports)
      // is treated as a row end too.
      if (text[i + 1] !== '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        line++;
      }
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      line++;
    } else {
      cell += char;
    }
  }

  if (inQuotes) {
    throw new CsvError(
      'The file ends inside an unclosed quoted field. It is probably truncated.',
      { line },
    );
  }

  // Final row, if the file does not end with a newline.
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const trimmed = rows.map((r) => r.map((c) => c.trim()));
  const nonEmpty = trimmed.filter((r) => r.some((c) => c !== ''));

  if (nonEmpty.length < trimmed.length) {
    notes.push(`Skipped ${trimmed.length - nonEmpty.length} blank line(s).`);
  }
  if (nonEmpty.length === 0) {
    throw new CsvError('The file contains no data rows.');
  }

  return { rows: nonEmpty, delimiter, notes };
}

/**
 * Guess the delimiter by finding which candidate produces the most *consistent*
 * column count across the first several lines.
 *
 * Counting raw occurrences is the obvious approach and it is wrong: a
 * description column full of commas ("PAYMENT TO SHARMA TRADERS, LALITPUR")
 * beats the real delimiter on raw count. Consistency does not have that
 * failure mode, because a wrong delimiter produces ragged rows.
 */
function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 20);
  if (sample.length === 0) return ',';

  let best = { delimiter: ',', score: -1 };

  for (const delimiter of DELIMITERS) {
    const counts = sample.map((line) => countOutsideQuotes(line, delimiter));
    const populated = counts.filter((c) => c > 0);
    if (populated.length === 0) continue;

    const modal = mode(populated);
    const agreement = populated.filter((c) => c === modal).length / sample.length;
    // Prefer consistency first, then the delimiter that yields more columns —
    // which breaks the tie in favour of the real separator when a file happens
    // to be consistent under two candidates.
    const score = agreement * 100 + Math.min(modal, 20);

    if (score > best.score) best = { delimiter, score };
  }

  return best.delimiter;
}

function countOutsideQuotes(line, delimiter) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (!inQuotes && line[i] === delimiter) count++;
  }
  return count;
}

function mode(values) {
  const tally = new Map();
  for (const v of values) tally.set(v, (tally.get(v) || 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [value, count] of tally) {
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function describeDelimiter(delimiter) {
  return { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[delimiter] || delimiter;
}

/**
 * Find the real header row.
 *
 * Bank exports routinely put branding, an account number, a statement period
 * and a blank line above the actual column headers. Taking row 0 as the header
 * — which is what every naive importer does — produces a table whose columns
 * are named after the bank's address.
 *
 * The header is identified as the first row that both looks like labels rather
 * than data, and matches the modal column count of the rows beneath it.
 *
 * @param {string[][]} rows
 * @param {number} [searchLimit=15] how far down to look before giving up
 * @returns {{headerIndex:number, header:string[], preamble:string[][]}}
 */
function findHeaderRow(rows, searchLimit = 15) {
  // Only rows with more than one column vote on the table's width. A branding
  // preamble is a run of single-cell lines, and letting those vote makes the
  // modal width 1 — at which point the real header, being wider, is skipped and
  // the file looks headerless.
  const widths = rows.map((r) => r.length).filter((w) => w > 1);
  if (widths.length === 0) {
    throw new CsvError('The file has no row with more than one column.');
  }
  const modalWidth = mode(widths);

  const limit = Math.min(searchLimit, rows.length);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (row.length !== modalWidth) continue;
    if (row.filter((c) => c !== '').length < 2) continue;
    // A header cell is text, not a number or a date. If most cells in the row
    // parse as data, this is a data row and the file has no header at all.
    const labelish = row.filter((c) => c !== '' && !looksLikeData(c)).length;
    if (labelish >= Math.ceil(row.filter((c) => c !== '').length * 0.6)) {
      return { headerIndex: i, header: row, preamble: rows.slice(0, i) };
    }
  }

  throw new CsvError(
    'Could not find a header row. The first 15 lines contain no row of column ' +
      'labels, so there is no safe way to tell which column holds the amount.',
  );
}

function looksLikeData(cell) {
  const s = cell.trim();
  if (s === '') return false;
  if (/^[(-]?\s*(rs\.?|npr)?\s*[\d,]+(\.\d+)?\s*\)?\s*(dr|cr)?\.?$/i.test(s)) return true;
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(s)) return true;
  return false;
}

/**
 * Turn rows into objects keyed by header label, dropping any trailing summary
 * rows the bank appended ("TOTAL", "Closing balance", "*** End of statement").
 *
 * @returns {{records: Array<{values: object, rowNumber: number, raw: string[]}>,
 *            header: string[], notes: string[], skipped: Array}}
 */
function toRecords(text, options = {}) {
  const { rows, delimiter, notes } = parseCsv(text, options);
  const { headerIndex, header, preamble } = findHeaderRow(rows);

  if (preamble.length > 0) {
    notes.push(
      `Ignored ${preamble.length} line(s) of preamble above the column headers.`,
    );
  }

  const records = [];
  const skipped = [];

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const raw = rows[i];
    // +1 twice: rows are zero-indexed, and humans count the header as line 1.
    const rowNumber = i + 1;

    if (isSummaryRow(raw)) {
      skipped.push({ rowNumber, raw, reason: 'summary or total row' });
      continue;
    }
    if (raw.every((c) => c === '')) continue;

    const values = {};
    header.forEach((key, col) => {
      if (key === '') return;
      values[key] = raw[col] ?? '';
    });

    // A ragged row is kept, not dropped — the columns that are present may
    // still be readable — but the fact is recorded so it can be surfaced.
    if (raw.length !== header.length) {
      skipped.push({
        rowNumber,
        raw,
        reason: `row has ${raw.length} columns, header has ${header.length}`,
        recovered: true,
      });
    }

    records.push({ values, rowNumber, raw });
  }

  if (records.length === 0) {
    throw new CsvError('The file has a header but no readable data rows beneath it.');
  }

  return { records, header, delimiter, notes, skipped };
}

const SUMMARY_PATTERNS = [
  /^\s*\**\s*(grand\s+)?total/i,
  /^\s*closing\s+balance/i,
  /^\s*opening\s+balance/i,
  /^\s*\*+\s*end\s+of/i,
  /^\s*-{3,}\s*$/,
];

function isSummaryRow(raw) {
  const populated = raw.filter((c) => c !== '');
  if (populated.length === 0) return false;

  // A total line announces itself in its first cell — and that cell is a label,
  // not data. Requiring both is what separates "TOTAL,,500,700" from a genuine
  // transaction, whose first cell is a date or a serial number. Counting empty
  // cells does not work: a total row carries its own column totals and so is
  // about as populated as a data row.
  const first = raw.find((c) => c !== '');
  if (looksLikeData(first)) return false;
  return SUMMARY_PATTERNS.some((p) => p.test(first));
}

module.exports = {
  CsvError,
  parseCsv,
  toRecords,
  findHeaderRow,
  _internals: { sniffDelimiter, isSummaryRow, looksLikeData, mode },
};
