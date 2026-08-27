/**
 * AI extraction: reading a messy invoice into structured, VERIFIED fields.
 *
 * ─── WHERE THE MODEL SITS IN THIS PRODUCT ───────────────────────────────────
 *
 *   model            reads a document and points at where each value is
 *   grounding.js     checks that the value is actually there
 *   domain/tax.js    computes every figure, deterministically
 *   the accountant   confirms, and signs
 *
 * The model's output is never a figure. It is a claim about the document, and
 * the claim is checked before anything is built on it. An extraction with a
 * single ungrounded field is refused whole and becomes a flag for a human — not
 * a set of transactions with one bad number in it.
 *
 * ─── WHY A TOOL LOOP AND NOT ONE CALL ───────────────────────────────────────
 *
 * A single prompt can read an invoice. It cannot tell you the same bill was
 * already booked last month under a different supplier spelling, which is a
 * finding an accountant genuinely wants. The tools let the model look things up
 * before it commits — and every tool is read-only, so however it reasons, it
 * cannot change a record.
 */

const { z } = require('zod');
const { buildTools } = require('./tools');
const { verifyExtraction } = require('./grounding');

const MODEL = 'claude-opus-5';

/** Amount fields are grounded numerically rather than by characters. */
const AMOUNT_FIELDS = ['taxableAmount', 'vatAmount', 'grossAmount'];

/**
 * Every field is a value AND the text it was read from.
 *
 * Demanding the quote is what makes grounding possible: a model that must point
 * at its source cannot report a figure that is not in the document without the
 * mismatch being visible.
 *
 * Amounts are STRINGS, deliberately. A number here would be a number the model
 * produced, and domain/money.js is the only thing in this system allowed to
 * turn written text into a figure. The model transcribes; we parse.
 */
const quoted = (description) =>
  z.object({
    value: z.string().nullable().describe(description),
    quote: z
      .string()
      .nullable()
      .describe('The exact text from the document this value was read from, verbatim.'),
  });

const ExtractionSchema = z.object({
  documentKind: z
    .enum(['sales_invoice', 'purchase_invoice', 'receipt', 'other'])
    .describe('What kind of document this is.'),
  invoiceNumber: quoted('The invoice or bill number, exactly as printed.'),
  invoiceDate: quoted('The invoice date, exactly as printed — do not reformat it.'),
  party: quoted('The other party: the supplier on a purchase, the customer on a sale.'),
  partyPan: quoted("The other party's PAN or VAT number, if printed."),
  taxableAmount: quoted('The taxable value before VAT, exactly as printed.'),
  vatAmount: quoted('The VAT amount, exactly as printed.'),
  grossAmount: quoted('The total including VAT, exactly as printed.'),
  suggestedTdsCategory: z
    .string()
    .nullable()
    .describe('A TDS category from list_tds_categories, or null if unsure. A suggestion only.'),
  notes: z
    .string()
    .nullable()
    .describe('Anything an accountant should know: unreadable text, an odd total, a missing field.'),
});

const SYSTEM_PROMPT = `You are helping a chartered accountant in Nepal read a client's invoice.

Your job is to LOCATE values in the document. It is not to calculate anything.

Rules, in order of importance:

1. Every value you report must be copied EXACTLY as printed, and every value
   must come with the exact text you read it from. Copy that text verbatim,
   including its spacing and punctuation. Your quotes are checked against the
   document; a quote that is not in the document invalidates the whole
   extraction.

2. Never compute, derive, infer or correct a figure. If an invoice's total does
   not equal its taxable amount plus its VAT, report all three EXACTLY as
   printed and say so in your notes. The discrepancy is precisely what the
   accountant needs to see. Silently fixing it would hide the finding.

3. If a value is not on the document, report null. Do not guess, and do not
   reconstruct a value from other fields. "It is not there" is a correct and
   useful answer.

4. Do not reformat anything. A date printed 17/07/2024 is reported as
   17/07/2024, not as 2024-07-17. An amount printed 11,300.00 keeps its comma.

You may call tools to read the document, check the client's existing records,
and see which TDS categories exist. Read the document before reporting anything.`;

/**
 * Extract one document.
 *
 * @param {object} input
 * @param {string} input.documentText  the text to read
 * @param {object} input.context       { firmId, clientId, fiscalPeriodId }
 * @param {object} deps
 * @param {object} deps.client         an Anthropic client
 * @param {Function} deps.betaZodTool
 * @param {Function} deps.betaZodOutputFormat
 * @param {number} [deps.maxIterations=8]
 */
async function extractInvoice(
  { documentText, context },
  { client, betaZodTool, betaZodOutputFormat, maxIterations = 8, logger = console },
) {
  if (!documentText || documentText.trim().length === 0) {
    throw new Error('There is no text to extract from.');
  }

  const { tools, calls } = buildTools({ ...context, documentText }, { betaZodTool });

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    // Adaptive thinking: reading a badly-scanned invoice and noticing that a
    // total does not add up is exactly the kind of work it helps with.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: betaZodOutputFormat(ExtractionSchema, 'invoice_extraction'),
    },
    system: SYSTEM_PROMPT,
    tools,
    max_iterations: maxIterations,
    messages: [
      {
        role: 'user',
        content:
          'Read this invoice and report its fields. Call get_document_text first.',
      },
    ],
  });

  let finalMessage;
  for await (const message of runner) {
    // A server tool can pause a turn. The runner only resumes after a CLIENT
    // tool returns, so a paused turn would otherwise end the loop quietly and
    // hand back a truncated answer with no error at all.
    if (message.stop_reason === 'pause_turn') {
      runner.pushMessages({ role: 'assistant', content: message.content });
    }
    finalMessage = message;
  }

  if (!finalMessage) throw new Error('The model returned nothing.');

  // A refusal is a real outcome, not an exception. Surfaced as a flag so an
  // accountant sees why rather than an empty result.
  if (finalMessage.stop_reason === 'refusal') {
    return {
      status: 'refused',
      reason: finalMessage.stop_details?.explanation ?? 'The model declined to read this document.',
      toolCalls: calls,
    };
  }

  // Hitting the iteration cap means the loop ended mid-thought. Treating that
  // as a successful extraction is how a half-read document becomes transactions.
  if (finalMessage.stop_reason === 'tool_use') {
    return {
      status: 'incomplete',
      reason: `The model was still working after ${maxIterations} steps and did not finish.`,
      toolCalls: calls,
    };
  }

  // ─── Parsing the structured output ──────────────────────────────────────
  //
  // `parsed_output` is populated by client.messages.parse(), NOT by the tool
  // runner — the runner returns a plain Message and leaves the JSON in a text
  // block. Reading `finalMessage.parsed_output` here returned undefined on
  // every call, which would have turned every extraction into "unparseable".
  //
  // A stub client cannot catch that, because a stub returns whatever field the
  // author expects. Running the real SDK against a local server did.
  const extraction = parseStructuredOutput(finalMessage);
  if (!extraction.ok) {
    return {
      status: 'unparseable',
      reason: extraction.reason,
      toolCalls: calls,
    };
  }

  // ---- The gate -----------------------------------------------------------
  const grounding = verifyExtraction(documentText, extraction.value, {
    amountFields: AMOUNT_FIELDS,
  });

  if (grounding.verdict !== 'grounded') {
    logger.warn?.({ ungrounded: grounding.ungrounded }, 'extraction rejected as ungrounded');
    return {
      status: 'ungrounded',
      reason:
        `${grounding.ungrounded.length} of ${grounding.checked} extracted values could ` +
        `not be found in the document.`,
      ungrounded: grounding.ungrounded,
      extraction: extraction.value,
      toolCalls: calls,
    };
  }

  return {
    status: 'extracted',
    extraction: extraction.value,
    grounding,
    toolCalls: calls,
    usage: finalMessage.usage,
  };
}

/**
 * Pull the structured object out of the final message and validate it.
 *
 * Validated against the same Zod schema that was sent, so a response missing a
 * field or carrying a number where a string was asked for is rejected here
 * rather than surfacing later as a confusing grounding failure.
 */
function parseStructuredOutput(message) {
  // A tool-runner message may already carry it if the SDK gains that behaviour;
  // preferring it costs nothing and keeps this working if it does.
  if (message.parsed_output) return { ok: true, value: message.parsed_output };

  const text = (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (!text) {
    return { ok: false, reason: 'The model returned no structured fields at all.' };
  }

  let raw;
  try {
    // Never string-match a model's JSON — escaping varies between models.
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: 'The model\'s reply was not valid JSON, so no fields could be read from it.',
    };
  }

  const validated = ExtractionSchema.safeParse(raw);
  if (!validated.success) {
    const problems = validated.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .slice(0, 5)
      .join('; ');
    return { ok: false, reason: `The extracted fields did not match the expected shape — ${problems}` };
  }

  return { ok: true, value: validated.data };
}

/**
 * Turn a verified extraction into the shape the pipeline already understands.
 *
 * Note what this does NOT do: it does not compute VAT, does not derive a
 * missing total, and does not decide a TDS figure. It hands over what was read,
 * marked as reported-by-the-client, and the deterministic engine takes it from
 * there — exactly as it does for a CSV register.
 *
 * The AI path and the CSV path converge here, which is the point: extraction is
 * a different way of READING a document, not a different way of computing tax.
 */
function toTransactionDraft(extraction, { documentId, sourceRef = {} }) {
  const value = (field) => (field && field.value ? field.value : null);

  return {
    documentId,
    source: 'ledger',
    kind: extraction.documentKind === 'sales_invoice' ? 'sale' : 'purchase',
    // Left as written. utils/dates.js parses it, with the same refusal to guess
    // at an ambiguous date that the CSV importer has.
    rawDate: value(extraction.invoiceDate),
    party: value(extraction.party),
    partyPan: value(extraction.partyPan),
    invoiceNumber: value(extraction.invoiceNumber),
    // Strings. domain/money.js turns text into figures; nothing else does.
    rawTaxableAmount: value(extraction.taxableAmount),
    rawVatAmount: value(extraction.vatAmount),
    rawGrossAmount: value(extraction.grossAmount),
    // A suggestion, recorded as a suggestion. A human confirms it before it
    // affects a TDS figure.
    suggestedTdsCategory: extraction.suggestedTdsCategory ?? null,
    categorySource: 'ai',
    notes: extraction.notes ?? null,
    sourceRef: {
      ...sourceRef,
      extractedBy: MODEL,
      // The quotes are kept. Provenance for an AI-read document is the text it
      // pointed at, and it has to survive so a reviewer can check the same
      // characters the grounding check did.
      quotes: Object.fromEntries(
        Object.entries(extraction)
          .filter(([, f]) => f && typeof f === 'object' && f.quote)
          .map(([name, f]) => [name, f.quote]),
      ),
    },
  };
}

module.exports = {
  MODEL,
  parseStructuredOutput,
  ExtractionSchema,
  SYSTEM_PROMPT,
  AMOUNT_FIELDS,
  extractInvoice,
  toTransactionDraft,
};
