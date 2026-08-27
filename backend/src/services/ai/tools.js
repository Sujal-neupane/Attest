/**
 * The tools the model may call.
 *
 * Every one of these is a real function against real data — not a description
 * of a capability. That is the difference between a tool-calling agent and a
 * prompt that pretends to have one.
 *
 * ─── WHAT THESE TOOLS DELIBERATELY CANNOT DO ────────────────────────────────
 *
 * There is no tool that computes VAT, no tool that writes a transaction, and no
 * tool that resolves a flag. The model can LOOK — at the document, at the
 * client's history, at what a party was called before — and it can PROPOSE. It
 * cannot change anything, and nothing it returns reaches a return without
 * passing the grounding check and then the deterministic engine.
 *
 * The read-only surface is not a limitation to be lifted later. It is the
 * design: an agent that can only read cannot cause a wrong figure to be filed,
 * whatever it decides.
 *
 * Every tool is also firm-scoped through withFirm(), so the model working on
 * one firm's document cannot see another firm's data even if it asks.
 */

const { z } = require('zod');
const { withFirm } = require('../../config/db');
const { TDS_RATES } = require('../../domain/tax');

/**
 * @param {object} context  { firmId, clientId, fiscalPeriodId, documentText }
 * @param {object} deps     { betaZodTool } — injected so tests do not need the SDK
 */
function buildTools(context, { betaZodTool }) {
  const calls = [];
  const record = (name, input, summary) => calls.push({ name, input, summary });

  const searchTransactions = betaZodTool({
    name: 'search_transactions',
    description:
      "Search this client's already-imported transactions by party name, " +
      'invoice number, or amount. Use it to check whether an invoice has ' +
      'already been recorded, or to see what a supplier has been called ' +
      'before. Returns at most 20 matches.',
    inputSchema: z.object({
      party: z.string().optional().describe('Party name, matched approximately'),
      invoiceNumber: z.string().optional().describe('Exact invoice number'),
      amountPaisa: z
        .number()
        .int()
        .optional()
        .describe('Exact amount in paisa (100 paisa = 1 rupee)'),
    }),
    run: async (input) => {
      const rows = await withFirm(context.firmId, async (db) => {
        const { rows: found } = await db.query(
          `SELECT t.txn_date AS "date", t.party, t.invoice_number AS "invoiceNumber",
                  t.amount_paisa AS "amountPaisa", t.kind, d.filename
             FROM transactions t
             JOIN documents d ON d.id = t.document_id
            WHERE t.client_id = $1
              AND ($2::text IS NULL OR t.party ILIKE '%' || $2 || '%')
              AND ($3::text IS NULL OR t.invoice_number = $3)
              AND ($4::bigint IS NULL OR abs(t.amount_paisa) = abs($4))
            ORDER BY t.txn_date DESC
            LIMIT 20`,
          [
            context.clientId,
            input.party ?? null,
            input.invoiceNumber ?? null,
            input.amountPaisa ?? null,
          ],
        );
        return found;
      });

      record('search_transactions', input, `${rows.length} match(es)`);
      return rows.length === 0
        ? 'No matching transactions found for this client.'
        : JSON.stringify(rows);
    },
  });

  const getDocumentText = betaZodTool({
    name: 'get_document_text',
    description:
      'Read the full text of the document being extracted. Call this before ' +
      'reporting any value — every figure you report must be quoted verbatim ' +
      'from this text.',
    inputSchema: z.object({}),
    run: async () => {
      record('get_document_text', {}, `${context.documentText.length} characters`);
      return context.documentText;
    },
  });

  const listTdsCategories = betaZodTool({
    name: 'list_tds_categories',
    description:
      'List the TDS categories Attest recognises, with their sections. Use ' +
      'this to pick a category for a payment. You are proposing a ' +
      'classification only — Attest computes the tax itself, and an ' +
      'accountant confirms the category before it is used.',
    inputSchema: z.object({}),
    run: async () => {
      record('list_tds_categories', {}, `${Object.keys(TDS_RATES).length} categories`);
      // The RATES are deliberately not included. A model that can see "15%"
      // is a model that will helpfully multiply, and the whole point is that
      // it never does. It picks a label; domain/tax.js knows what that costs.
      return JSON.stringify(
        Object.entries(TDS_RATES).map(([key, rule]) => ({
          category: key,
          describes: rule.label,
          section: rule.section,
        })),
      );
    },
  });

  const getClientContext = betaZodTool({
    name: 'get_client_context',
    description:
      'Basic facts about the client whose books this document belongs to: ' +
      'name, PAN, and the fiscal period being worked on. Use it to tell ' +
      'whether the document belongs to this client at all.',
    inputSchema: z.object({}),
    run: async () => {
      const info = await withFirm(context.firmId, async (db) => {
        const { rows } = await db.query(
          `SELECT c.name, c.pan, p.label AS "period",
                  p.start_date AS "periodStart", p.end_date AS "periodEnd"
             FROM clients c
             JOIN fiscal_periods p ON p.id = $2
            WHERE c.id = $1`,
          [context.clientId, context.fiscalPeriodId],
        );
        return rows[0] ?? null;
      });

      record('get_client_context', {}, info ? info.name : 'not found');
      return info ? JSON.stringify(info) : 'Client not found.';
    },
  });

  return {
    tools: [getDocumentText, getClientContext, searchTransactions, listTdsCategories],
    /** What the model actually did, for the audit trail. */
    calls,
  };
}

module.exports = { buildTools };
