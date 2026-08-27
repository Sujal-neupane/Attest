/**
 * The extraction loop driven by the REAL Anthropic SDK.
 *
 * extract.test.js replaces the client, so it proves the logic and nothing about
 * the integration. These tests point the genuine `@anthropic-ai/sdk` at a local
 * server: the request is built by the real client, serialised over real HTTP,
 * and the reply is parsed by the real response types.
 *
 * That distinction is not academic. It is what caught the bug that
 * `parsed_output` is populated by `client.messages.parse()` and NOT by the tool
 * runner — the runner leaves the JSON in a text block. Every extraction would
 * have returned "unparseable". A stub could never have found it, because a stub
 * returns whatever field its author expects to read.
 *
 * No API key, no network, no cost.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Anthropic = require('@anthropic-ai/sdk');
const { betaZodTool, betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');

const { createMockAnthropic, toolUse, structured } = require('./helpers/mockAnthropic');
const { extractInvoice } = require('../src/services/ai/extract');

const INVOICE = `
SHARMA TRADERS PVT LTD
Lalitpur, Nepal        PAN: 301234567

TAX INVOICE                       Invoice No: INV-2081-0042
                                  Date: 17/07/2024

                          Taxable Amount       10,000.00
                          VAT @ 13%             1,300.00
                          Grand Total          11,300.00
`;

const field = (value, quote) => ({ value, quote });

const HONEST = {
  documentKind: 'purchase_invoice',
  invoiceNumber: field('INV-2081-0042', 'Invoice No: INV-2081-0042'),
  invoiceDate: field('17/07/2024', 'Date: 17/07/2024'),
  party: field('SHARMA TRADERS PVT LTD', 'SHARMA TRADERS PVT LTD'),
  partyPan: field('301234567', 'PAN: 301234567'),
  taxableAmount: field('10,000.00', 'Taxable Amount       10,000.00'),
  vatAmount: field('1,300.00', 'VAT @ 13%             1,300.00'),
  grossAmount: field('11,300.00', 'Grand Total          11,300.00'),
  suggestedTdsCategory: null,
  notes: null,
};

async function withMock(script, run) {
  const mock = createMockAnthropic(script);
  const baseURL = await mock.listen();
  const client = new Anthropic({ apiKey: 'not-a-real-key', baseURL, maxRetries: 0 });

  try {
    return await run({ client, betaZodTool, betaZodOutputFormat }, mock);
  } finally {
    await mock.close();
  }
}

const context = { firmId: 'f', clientId: 'c', fiscalPeriodId: 'p' };

test('the real SDK completes a tool loop and the fields come back verified', async () => {
  const result = await withMock(
    [toolUse('get_document_text', {}), structured(HONEST)],
    (deps) => extractInvoice({ documentText: INVOICE, context }, deps),
  );

  assert.equal(result.status, 'extracted');
  assert.equal(result.extraction.grossAmount.value, '11,300.00');
  assert.equal(result.grounding.verdict, 'grounded');
});

test('the tool actually runs, and its result is sent back to the model', async () => {
  await withMock(
    [toolUse('get_document_text', {}), structured(HONEST)],
    async (deps, mock) => {
      await extractInvoice({ documentText: INVOICE, context }, deps);

      assert.equal(mock.requests.length, 2, 'a tool call means a second request');

      const followUp = mock.requests[1].body.messages.at(-1);
      assert.equal(followUp.role, 'user');
      assert.equal(followUp.content[0].type, 'tool_result');
      // The document text really reached the model — the tool ran for real.
      assert.match(followUp.content[0].content, /SHARMA TRADERS/);
    },
  );
});

test('the request carries the tools, the schema and the model we intend', async () => {
  await withMock([structured(HONEST)], async (deps, mock) => {
    await extractInvoice({ documentText: INVOICE, context }, deps);

    const { body } = mock.requests[0];
    assert.equal(body.model, 'claude-opus-5');
    assert.equal(body.thinking.type, 'adaptive');
    assert.equal(body.output_config.effort, 'high');

    const toolNames = body.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      'get_client_context',
      'get_document_text',
      'list_tds_categories',
      'search_transactions',
    ]);

    // The schema really is sent, so the model is constrained rather than asked
    // nicely for JSON.
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.ok(body.output_config.format.schema.properties.grossAmount);
  });
});

test('the system prompt tells the model not to compute anything', async () => {
  await withMock([structured(HONEST)], async (deps, mock) => {
    await extractInvoice({ documentText: INVOICE, context }, deps);
    const system = JSON.stringify(mock.requests[0].body.system);
    assert.match(system, /Never compute, derive, infer or correct a figure/);
    assert.match(system, /quotes are checked against the/);
  });
});

test('AN INVENTED FIGURE IS REFUSED — through the real client too', async () => {
  const result = await withMock(
    [structured({ ...HONEST, grossAmount: field('13,100.00', 'Grand Total          11,300.00') })],
    (deps) => extractInvoice({ documentText: INVOICE, context }, deps),
  );

  assert.equal(result.status, 'ungrounded');
  assert.equal(result.ungrounded[0].field, 'grossAmount');
});

test('a reply that is not valid JSON is reported, not thrown', async () => {
  const result = await withMock(
    [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here you go: not json' }] }],
    (deps) => extractInvoice({ documentText: INVOICE, context }, deps),
  );

  assert.equal(result.status, 'unparseable');
  assert.match(result.reason, /not valid JSON/);
});

test('a reply missing a required field is rejected by the schema, with the field named', async () => {
  // Destructured out deliberately — the point is the field's ABSENCE.
  const incomplete = { ...HONEST };
  delete incomplete.grossAmount;
  const result = await withMock([structured(incomplete)], (deps) =>
    extractInvoice({ documentText: INVOICE, context }, deps),
  );

  assert.equal(result.status, 'unparseable');
  // A missing field must be named, or the accountant sees only "extraction
  // failed" and has nothing to act on.
  assert.match(result.reason, /grossAmount/);
});

test('an API error surfaces as an error rather than a silent empty result', async () => {
  await assert.rejects(
    () =>
      withMock(
        [{ __status: 429, error: { type: 'rate_limit_error', message: 'slow down' } }],
        (deps) => extractInvoice({ documentText: INVOICE, context }, deps),
      ),
    (err) => err instanceof Anthropic.RateLimitError,
  );
});

test('the loop stops at its iteration cap instead of running forever', async () => {
  // A model that only ever asks for tools would otherwise loop indefinitely,
  // spending money on every turn.
  const result = await withMock(
    Array.from({ length: 20 }, () => toolUse('get_document_text', {})),
    (deps) => extractInvoice({ documentText: INVOICE, context }, { ...deps, maxIterations: 3 }),
  );

  assert.equal(result.status, 'incomplete');
  assert.match(result.reason, /after 3 steps/);
});
