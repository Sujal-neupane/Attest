const test = require('node:test');
const assert = require('node:assert/strict');
const { extractInvoice, toTransactionDraft } = require('../src/services/ai/extract');

/**
 * The extraction loop, with a stubbed client.
 *
 * No API key, no network, no cost, and — more importantly — no randomness. The
 * behaviours being tested are what happens when the model does something
 * WRONG: invents a figure, runs out of steps, refuses, returns nothing. Those
 * are exactly the cases a live call will not reliably produce on demand, and
 * exactly the ones that must never reach a tax return.
 *
 * The real client is exercised separately, by hand, against a real invoice.
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

const HONEST_OUTPUT = {
  documentKind: 'purchase_invoice',
  invoiceNumber: field('INV-2081-0042', 'Invoice No: INV-2081-0042'),
  invoiceDate: field('17/07/2024', 'Date: 17/07/2024'),
  party: field('SHARMA TRADERS PVT LTD', 'SHARMA TRADERS PVT LTD'),
  partyPan: field('301234567', 'PAN: 301234567'),
  taxableAmount: field('10,000.00', 'Taxable Amount       10,000.00'),
  vatAmount: field('1,300.00', 'VAT @ 13%             1,300.00'),
  grossAmount: field('11,300.00', 'Grand Total          11,300.00'),
  suggestedTdsCategory: 'service_contract',
  notes: null,
};

/** A client that returns exactly the messages it is given. */
function stubClient(messages) {
  return {
    beta: {
      messages: {
        toolRunner() {
          const queue = [...messages];
          return {
            pushMessages() {},
            async *[Symbol.asyncIterator]() {
              while (queue.length) yield queue.shift();
            },
          };
        },
      },
    },
  };
}

const deps = (messages) => ({
  client: stubClient(messages),
  // The tools are never invoked by the stub, so these only need to be callable.
  betaZodTool: (definition) => definition,
  betaZodOutputFormat: (schema, name) => ({ type: 'json_schema', name }),
  logger: {},
});

const run = (messages, text = INVOICE) =>
  extractInvoice(
    { documentText: text, context: { firmId: 'f', clientId: 'c', fiscalPeriodId: 'p' } },
    deps(messages),
  );

test('an honest extraction is accepted and carries its grounding', async () => {
  const result = await run([
    { stop_reason: 'end_turn', parsed_output: HONEST_OUTPUT, usage: { output_tokens: 400 } },
  ]);

  assert.equal(result.status, 'extracted');
  assert.equal(result.extraction.invoiceNumber.value, 'INV-2081-0042');
  assert.equal(result.grounding.verdict, 'grounded');
});

test('AN INVENTED FIGURE IS REFUSED, NOT RETURNED', async () => {
  // The whole reason the AI path is safe to have. The model reports a total of
  // 13,100 while quoting a line that says 11,300 — plausible, arithmetically
  // consistent with nothing, and completely undetectable downstream.
  const result = await run([
    {
      stop_reason: 'end_turn',
      parsed_output: {
        ...HONEST_OUTPUT,
        grossAmount: field('13,100.00', 'Grand Total          11,300.00'),
      },
    },
  ]);

  assert.equal(result.status, 'ungrounded');
  assert.equal(result.ungrounded[0].field, 'grossAmount');
  assert.match(result.reason, /could not be found in the document/);
});

test('one bad field refuses the whole extraction, not just that field', async () => {
  const result = await run([
    {
      stop_reason: 'end_turn',
      parsed_output: { ...HONEST_OUTPUT, party: field('Gurung Hardware', 'SHARMA TRADERS PVT LTD') },
    },
  ]);

  // Returning six good fields and one bad one would be the worst outcome
  // available: it looks complete.
  assert.equal(result.status, 'ungrounded');
  assert.equal(result.extraction.invoiceNumber.value, 'INV-2081-0042', 'kept for the reviewer');
});

test('running out of steps is reported as incomplete, never as success', async () => {
  const result = await run([{ stop_reason: 'tool_use', content: [] }]);

  assert.equal(result.status, 'incomplete');
  assert.match(result.reason, /still working after/);
});

test('a refusal is surfaced with its reason rather than thrown away', async () => {
  const result = await run([
    {
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', explanation: 'Declined to process this content.' },
    },
  ]);

  assert.equal(result.status, 'refused');
  assert.match(result.reason, /Declined to process/);
});

test('a missing structured output is reported, not treated as empty fields', async () => {
  const result = await run([{ stop_reason: 'end_turn', parsed_output: null }]);
  assert.equal(result.status, 'unparseable');
});

test('a paused turn is resumed rather than silently truncating the answer', async () => {
  // The runner only continues after a CLIENT tool returns, so a server-tool
  // pause would otherwise end the loop with no error and a partial answer.
  let pushed = 0;
  const client = {
    beta: {
      messages: {
        toolRunner: () => ({
          pushMessages: () => { pushed++; },
          async *[Symbol.asyncIterator]() {
            yield { stop_reason: 'pause_turn', content: [] };
            yield { stop_reason: 'end_turn', parsed_output: HONEST_OUTPUT };
          },
        }),
      },
    },
  };

  const result = await extractInvoice(
    { documentText: INVOICE, context: { firmId: 'f', clientId: 'c', fiscalPeriodId: 'p' } },
    { ...deps([]), client },
  );

  assert.equal(pushed, 1, 'the paused turn must be pushed back to resume');
  assert.equal(result.status, 'extracted');
});

test('an empty document is refused before any model is called', async () => {
  let called = false;
  const client = {
    beta: { messages: { toolRunner: () => { called = true; } } },
  };

  await assert.rejects(
    () => extractInvoice(
      { documentText: '   ', context: {} },
      { ...deps([]), client },
    ),
    /no text to extract/,
  );
  assert.equal(called, false, 'do not pay for a request that cannot succeed');
});

// ---------------------------------------------------------------------------
// Handing over to the deterministic engine
// ---------------------------------------------------------------------------

test('the draft hands over TEXT, never computed figures', async () => {
  const draft = toTransactionDraft(HONEST_OUTPUT, { documentId: 'doc-1' });

  // Amounts leave this layer as the strings the document printed. Only
  // domain/money.js turns text into a figure, and only domain/tax.js computes
  // anything from it — exactly as on the CSV path.
  assert.equal(draft.rawGrossAmount, '11,300.00');
  assert.equal(typeof draft.rawGrossAmount, 'string');
  assert.equal(draft.rawDate, '17/07/2024', 'the date is not reformatted here either');

  assert.equal(draft.amountPaisa, undefined, 'no computed amount may appear');
  assert.equal(draft.vatPaisa, undefined, 'no computed VAT may appear');
  assert.equal(draft.netPaisa, undefined);
});

test("a suggested category is recorded AS a suggestion", async () => {
  const draft = toTransactionDraft(HONEST_OUTPUT, { documentId: 'doc-1' });
  assert.equal(draft.suggestedTdsCategory, 'service_contract');
  // "Who decided this was a service contract" is a question an auditor asks,
  // so the answer is stored rather than inferred later.
  assert.equal(draft.categorySource, 'ai');
});

test('the quotes survive into provenance, so a reviewer can check the same text', async () => {
  const draft = toTransactionDraft(HONEST_OUTPUT, { documentId: 'doc-1' });
  assert.equal(draft.sourceRef.quotes.grossAmount, 'Grand Total          11,300.00');
  assert.equal(draft.sourceRef.extractedBy, 'claude-opus-5');
});

test('an invoice whose own total does not add up is preserved, not corrected', async () => {
  // 10,000 + 1,300 should be 11,300. This invoice says 11,500. That is the
  // finding — a model that quietly "fixed" it would erase the reason the
  // accountant is being paid.
  const text = INVOICE.replace('11,300.00', '11,500.00');
  const result = await run(
    [
      {
        stop_reason: 'end_turn',
        parsed_output: {
          ...HONEST_OUTPUT,
          grossAmount: field('11,500.00', 'Grand Total          11,500.00'),
          notes: 'The printed total does not equal taxable plus VAT.',
        },
      },
    ],
    text,
  );

  assert.equal(result.status, 'extracted');
  const draft = toTransactionDraft(result.extraction, { documentId: 'doc-1' });
  assert.equal(draft.rawGrossAmount, '11,500.00', 'the wrong total must survive to be flagged');
  assert.match(draft.notes, /does not equal/);
});
