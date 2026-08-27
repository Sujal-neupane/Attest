/**
 * Deterministic Nepali VAT and TDS computation.
 *
 * NOTHING IN THIS FILE MAY EVER CALL A LANGUAGE MODEL, A NETWORK, A CLOCK, OR
 * A DATABASE. It is a pure function of its inputs. That is the whole point:
 * a figure that lands on a tax return must be reproducible, reviewable, and
 * unit-testable by a human accountant who does not trust us yet.
 *
 * The AI layer may *classify* a transaction (is this rent? a consultancy fee?).
 * Once a classification exists — proposed by AI, confirmed by a human — the
 * arithmetic below is the only thing that turns it into money.
 *
 * Rates are integers in basis points (1 bp = 0.01%) so no float ever holds a
 * tax rate. All rates are effective for FY 2081-82 and are versioned: when the
 * budget changes them, add a new entry rather than editing history, because
 * last year's return must still recompute to last year's number.
 */

const { applyRate, extractInclusive, sum, assertPaisa } = require('./money');

const VAT_RATE_BP = 1300; // 13%

/**
 * TDS rates by category. This is the v1 subset covering what a typical SME
 * ledger actually contains; the table is data, not code, so extending it is a
 * one-line change reviewed against the Income Tax Act schedule.
 *
 * `section` is recorded so the review report can cite the legal basis next to
 * every deduction — accountants check that, and it is cheap to carry.
 */
const TDS_RATES = Object.freeze({
  rent: { bp: 1000, section: 'Sec. 88(1)', label: 'Rent' },
  professional_fee: { bp: 1500, section: 'Sec. 88(1)', label: 'Professional / consultancy fee' },
  commission: { bp: 1500, section: 'Sec. 88(1)', label: 'Commission' },
  interest: { bp: 1500, section: 'Sec. 88(1)', label: 'Interest' },
  service_contract: { bp: 150, section: 'Sec. 89(1)', label: 'Contract / service payment' },
  dividend: { bp: 500, section: 'Sec. 88(2)', label: 'Dividend' },
  salary: { bp: 0, section: 'Sec. 87', label: 'Salary (computed separately on slab)' },
  none: { bp: 0, section: null, label: 'No TDS' },
});

/**
 * Payments below this threshold to a single payee under a service contract do
 * not attract TDS under Sec. 89. Encoded as paisa.
 */
const TDS_CONTRACT_THRESHOLD_PAISA = 50_000_00;

class TaxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaxError';
  }
}

/**
 * Split an amount into net + VAT.
 *
 * @param {object} input
 * @param {number} input.amountPaisa       the amount as it appears on the document
 * @param {boolean} input.vatInclusive     true if that amount already contains VAT
 * @param {boolean} input.vatApplicable    false for exempt / zero-rated supplies
 * @returns {{netPaisa:number, vatPaisa:number, grossPaisa:number, rateBp:number,
 *            basis:string}}
 */
function computeVat({ amountPaisa, vatInclusive = false, vatApplicable = true }) {
  assertPaisa(amountPaisa);

  if (!vatApplicable) {
    return {
      netPaisa: amountPaisa,
      vatPaisa: 0,
      grossPaisa: amountPaisa,
      rateBp: 0,
      basis: 'exempt_or_zero_rated',
    };
  }

  if (vatInclusive) {
    const vatPaisa = extractInclusive(amountPaisa, VAT_RATE_BP);
    return {
      netPaisa: amountPaisa - vatPaisa,
      vatPaisa,
      grossPaisa: amountPaisa,
      rateBp: VAT_RATE_BP,
      basis: 'inclusive',
    };
  }

  const vatPaisa = applyRate(amountPaisa, VAT_RATE_BP);
  return {
    netPaisa: amountPaisa,
    vatPaisa,
    grossPaisa: amountPaisa + vatPaisa,
    rateBp: VAT_RATE_BP,
    basis: 'exclusive',
  };
}

/**
 * Compute TDS withheld on a payment.
 *
 * TDS is deducted on the VAT-exclusive value of the payment, so callers must
 * pass the net figure — passing gross here is the single easiest way to file a
 * wrong return, which is why this function refuses to guess and demands an
 * explicit category.
 *
 * @param {object} input
 * @param {number} input.netPaisa   VAT-exclusive payment amount
 * @param {string} input.category   key of TDS_RATES
 * @param {number} [input.priorPaymentsPaisa=0] cumulative prior payments to the
 *        same payee in this fiscal year, used for the Sec. 89 threshold
 * @returns {{tdsPaisa:number, rateBp:number, section:string|null,
 *            category:string, payablePaisa:number, basis:string}}
 */
function computeTds({ netPaisa, category, priorPaymentsPaisa = 0 }) {
  assertPaisa(netPaisa);
  assertPaisa(priorPaymentsPaisa);

  const rule = TDS_RATES[category];
  if (!rule) {
    throw new TaxError(
      `Unknown TDS category "${category}". Known: ${Object.keys(TDS_RATES).join(', ')}`,
    );
  }

  // Sec. 89 threshold applies cumulatively across the fiscal year, not per bill.
  if (category === 'service_contract') {
    const cumulative = priorPaymentsPaisa + netPaisa;
    if (cumulative <= TDS_CONTRACT_THRESHOLD_PAISA) {
      return {
        tdsPaisa: 0,
        rateBp: 0,
        section: rule.section,
        category,
        payablePaisa: netPaisa,
        basis: 'below_annual_threshold',
      };
    }
  }

  const tdsPaisa = applyRate(netPaisa, rule.bp);
  return {
    tdsPaisa,
    rateBp: rule.bp,
    section: rule.section,
    category,
    payablePaisa: netPaisa - tdsPaisa,
    basis: rule.bp === 0 ? 'no_tds_rate' : 'standard_rate',
  };
}

/**
 * Compute the full tax position of a single transaction in one pass, so the
 * ordering (VAT first, TDS on the net) is decided here once instead of at every
 * call site.
 */
function computeTransactionTax({
  amountPaisa,
  vatInclusive = false,
  vatApplicable = true,
  tdsCategory = 'none',
  priorPaymentsPaisa = 0,
}) {
  const vat = computeVat({ amountPaisa, vatInclusive, vatApplicable });
  const tds = computeTds({
    netPaisa: vat.netPaisa,
    category: tdsCategory,
    priorPaymentsPaisa,
  });
  return { vat, tds };
}

/**
 * Aggregate a fiscal period into the figures that go on the VAT return.
 *
 * Output VAT is what the client collected on sales; input VAT (credit) is what
 * they paid on purchases. The difference is payable to, or creditable against,
 * the IRD. A negative net is carried forward as credit — the system reports it,
 * it does not decide what to do with it.
 *
 * @param {Array<{source:string, direction:string, netPaisa:number,
 *                vatPaisa:number, vatApplicable:boolean}>} lines
 */
function summarisePeriod(lines) {
  const sales = lines.filter((l) => l.kind === 'sale');
  const purchases = lines.filter((l) => l.kind === 'purchase');

  const taxableSales = sales.filter((l) => l.vatApplicable !== false);
  const exemptSales = sales.filter((l) => l.vatApplicable === false);
  const taxablePurchases = purchases.filter((l) => l.vatApplicable !== false);

  const outputVatPaisa = sum(taxableSales.map((l) => l.vatPaisa || 0));
  const inputVatPaisa = sum(taxablePurchases.map((l) => l.vatPaisa || 0));
  const netVatPaisa = outputVatPaisa - inputVatPaisa;

  return {
    taxableSalesPaisa: sum(taxableSales.map((l) => l.netPaisa || 0)),
    exemptSalesPaisa: sum(exemptSales.map((l) => l.netPaisa || 0)),
    taxablePurchasesPaisa: sum(taxablePurchases.map((l) => l.netPaisa || 0)),
    outputVatPaisa,
    inputVatPaisa,
    netVatPaisa,
    // Sign convention stated explicitly so no reader has to infer it.
    position: netVatPaisa > 0 ? 'payable' : netVatPaisa < 0 ? 'creditable' : 'nil',
    tdsWithheldPaisa: sum(lines.map((l) => l.tdsPaisa || 0)),
    lineCount: lines.length,
  };
}

module.exports = {
  VAT_RATE_BP,
  TDS_RATES,
  TDS_CONTRACT_THRESHOLD_PAISA,
  TaxError,
  computeVat,
  computeTds,
  computeTransactionTax,
  summarisePeriod,
};
