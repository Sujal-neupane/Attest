const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyExtraction, verifyField, appearsIn } = require('../src/services/ai/grounding');

/**
 * These are the tests that make "the AI never does the math" true rather than
 * merely stated. The tax engine stops a model from CALCULATING a figure; this
 * stops it from INVENTING one it claims to have read.
 *
 * No API key is needed to run any of them, which is the point: the rule that
 * polices the model must not depend on the model.
 */

const INVOICE = `
SHARMA TRADERS PVT LTD
Lalitpur, Nepal        PAN: 301234567

TAX INVOICE                       Invoice No: INV-2081-0042
                                  Date: 17/07/2024

Description                 Qty      Rate        Amount
Office paper, A4 ream        20    500.00     10,000.00

                          Taxable Amount       10,000.00
                          VAT @ 13%             1,300.00
                          Grand Total          11,300.00
`;

const field = (value, quote) => ({ value, quote });

test('a value the model actually read is accepted', () => {
  const result = verifyField(INVOICE, field('INV-2081-0042', 'Invoice No: INV-2081-0042'));
  assert.equal(result.grounded, true);
});

test('AN INVENTED AMOUNT IS REJECTED', () => {
  // The single most important test in this file. A transposition — 11,300
  // becoming 13,100 — is exactly what a language model produces, it is entirely
  // plausible, and every calculation performed on top of it would be perfect.
  const result = verifyField(
    INVOICE,
    field('13100.00', 'Grand Total          11,300.00'),
    { isAmount: true },
  );

  assert.equal(result.grounded, false);
  assert.equal(result.reason, 'amount_not_in_quote');
  assert.match(result.detail, /transposed or invented/);
});

test('the same amount written differently still grounds', () => {
  // The document says "11,300.00"; the model reports "11300.00". Same money.
  // Grounding must check the VALUE, not the characters, or it would reject
  // correct extractions and train everyone to ignore it.
  for (const claimed of ['11300.00', '11,300.00', 'Rs. 11,300.00', '11300']) {
    const result = verifyField(INVOICE, field(claimed, 'Grand Total          11,300.00'), {
      isAmount: true,
    });
    assert.equal(result.grounded, true, `${claimed} should ground`);
  }
});

test('a quote the model made up is rejected, even if the value is right', () => {
  const result = verifyField(
    INVOICE,
    field('11300.00', 'Total Payable: 11,300.00'), // that line is not in the invoice
    { isAmount: true },
  );
  assert.equal(result.grounded, false);
  assert.equal(result.reason, 'quote_not_in_document');
});

test('a real quote paired with a figure it does not contain is rejected', () => {
  // The subtle one: the model quotes a genuine line from the document, then
  // reports a number from somewhere else entirely.
  const result = verifyField(
    INVOICE,
    field('10000.00', 'Grand Total          11,300.00'),
    { isAmount: true },
  );
  assert.equal(result.grounded, false);
  assert.equal(result.reason, 'amount_not_in_quote');
});

test('a value reported with no source at all is rejected', () => {
  const result = verifyField(INVOICE, { value: '11300.00', quote: null }, { isAmount: true });
  assert.equal(result.grounded, false);
  assert.equal(result.reason, 'no_quote');
  assert.match(result.detail, /without saying where/);
});

test('a genuinely absent field is not a failure', () => {
  // Not every invoice has a PAN. "I could not find one" is a correct answer and
  // must not be punished, or the model learns to guess.
  assert.equal(verifyField(INVOICE, { value: null, quote: null }).grounded, true);
  assert.equal(verifyField(INVOICE, null).grounded, true);
});

test('line breaks from a PDF text layer do not break grounding', () => {
  // A PDF breaks lines wherever the column ended, so a party name really does
  // arrive split. Rejecting that would make the check useless on real scans.
  const wrapped = 'SHARMA\n   TRADERS\n   PVT LTD';
  assert.equal(appearsIn(wrapped, 'SHARMA TRADERS PVT LTD'), true);
});

test('unicode a model normalises away does not break grounding', () => {
  const fancy = 'Grand Total  Rs. 11,300.00';   // non-breaking spaces
  assert.equal(appearsIn(fancy, 'Grand Total Rs. 11,300.00'), true);

  const dashed = 'Invoice No–INV‑2081‑0042';     // en dash, non-breaking hyphens
  assert.equal(appearsIn(dashed, 'Invoice No-INV-2081-0042'), true);
});

test('an amount that is not a number is rejected rather than parsed loosely', () => {
  const result = verifyField(INVOICE, field('eleven thousand', 'Grand Total          11,300.00'), {
    isAmount: true,
  });
  assert.equal(result.grounded, false);
  assert.equal(result.reason, 'unparseable_amount');
});

// ---------------------------------------------------------------------------
// Whole extractions
// ---------------------------------------------------------------------------

const GOOD_EXTRACTION = {
  invoiceNumber: field('INV-2081-0042', 'Invoice No: INV-2081-0042'),
  invoiceDate: field('17/07/2024', 'Date: 17/07/2024'),
  party: field('SHARMA TRADERS PVT LTD', 'SHARMA TRADERS PVT LTD'),
  partyPan: field('301234567', 'PAN: 301234567'),
  taxableAmount: field('10000.00', 'Taxable Amount       10,000.00'),
  vatAmount: field('1300.00', 'VAT @ 13%             1,300.00'),
  grossAmount: field('11300.00', 'Grand Total          11,300.00'),
};

const AMOUNT_FIELDS = ['taxableAmount', 'vatAmount', 'grossAmount'];

test('a wholly honest extraction is accepted', () => {
  const result = verifyExtraction(INVOICE, GOOD_EXTRACTION, { amountFields: AMOUNT_FIELDS });
  assert.equal(result.verdict, 'grounded');
  assert.equal(result.ungrounded.length, 0);
  assert.equal(result.checked, 7);
});

test('ONE bad field rejects the WHOLE extraction', () => {
  // Deliberately all-or-nothing. A half-trusted extraction is the worst
  // possible object to hand downstream: it looks complete, and somewhere inside
  // it is a number nobody verified.
  const result = verifyExtraction(
    INVOICE,
    { ...GOOD_EXTRACTION, grossAmount: field('13100.00', 'Grand Total          11,300.00') },
    { amountFields: AMOUNT_FIELDS },
  );

  assert.equal(result.verdict, 'rejected');
  assert.equal(result.ungrounded.length, 1);
  assert.equal(result.ungrounded[0].field, 'grossAmount');
});

test('the rejection names the field and says what went wrong', () => {
  const result = verifyExtraction(
    INVOICE,
    { ...GOOD_EXTRACTION, party: field('Gurung Hardware', 'SHARMA TRADERS PVT LTD') },
    { amountFields: AMOUNT_FIELDS },
  );

  const [problem] = result.ungrounded;
  assert.equal(problem.field, 'party');
  // The accountant reads this. "Extraction failed" would tell them nothing.
  assert.match(problem.detail, /Gurung Hardware/);
  assert.match(problem.detail, /does not contain it/);
});

test('metadata the model adds is not mistaken for a claim about the document', () => {
  const result = verifyExtraction(
    INVOICE,
    { ...GOOD_EXTRACTION, confidence: 0.9, notes: 'Handwritten total, hard to read.' },
    { amountFields: AMOUNT_FIELDS },
  );
  assert.equal(result.verdict, 'grounded');
  assert.equal(result.checked, 7, 'confidence and notes are not fields to ground');
});

test('an empty extraction grounds vacuously rather than throwing', () => {
  assert.equal(verifyExtraction(INVOICE, {}).verdict, 'grounded');
  assert.equal(verifyExtraction(INVOICE, null).verdict, 'grounded');
});
