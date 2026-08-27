const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount } = require('../src/domain/money');
const tax = require('../src/domain/tax');

const rs = (v) => parseAmount(String(v));

test('VAT on a VAT-exclusive invoice', () => {
  const r = tax.computeVat({ amountPaisa: rs('100000'), vatInclusive: false });
  assert.equal(r.netPaisa, 10_000_000); // Rs. 100,000.00
  assert.equal(r.vatPaisa, 1_300_000); // Rs.  13,000.00
  assert.equal(r.grossPaisa, 11_300_000);
  assert.equal(r.basis, 'exclusive');
});

test('VAT extracted from a VAT-inclusive total', () => {
  const r = tax.computeVat({ amountPaisa: rs('113000'), vatInclusive: true });
  assert.equal(r.vatPaisa, 1_300_000);
  assert.equal(r.netPaisa, 10_000_000);
  assert.equal(r.netPaisa + r.vatPaisa, r.grossPaisa, 'net + vat must equal gross exactly');
});

test('net + VAT always equals gross, for every amount from 1 to 10,000 paisa', () => {
  for (let paisa = 1; paisa <= 10_000; paisa++) {
    const exclusive = tax.computeVat({ amountPaisa: paisa, vatInclusive: false });
    assert.equal(
      exclusive.netPaisa + exclusive.vatPaisa,
      exclusive.grossPaisa,
      `exclusive broke at ${paisa}`,
    );

    const inclusive = tax.computeVat({ amountPaisa: paisa, vatInclusive: true });
    assert.equal(
      inclusive.netPaisa + inclusive.vatPaisa,
      inclusive.grossPaisa,
      `inclusive broke at ${paisa}`,
    );
    assert.ok(inclusive.vatPaisa >= 0 && inclusive.netPaisa >= 0);
  }
});

test('exempt and zero-rated supplies attract no VAT', () => {
  const r = tax.computeVat({ amountPaisa: rs('50000'), vatApplicable: false });
  assert.equal(r.vatPaisa, 0);
  assert.equal(r.netPaisa, r.grossPaisa);
  assert.equal(r.basis, 'exempt_or_zero_rated');
});

test('TDS on rent is 10 percent and cites its section', () => {
  const r = tax.computeTds({ netPaisa: rs('50000'), category: 'rent' });
  assert.equal(r.tdsPaisa, 500_000); // Rs. 5,000.00
  assert.equal(r.payablePaisa, 4_500_000);
  assert.equal(r.rateBp, 1000);
  assert.equal(r.section, 'Sec. 88(1)');
});

test('TDS on a professional fee is 15 percent', () => {
  const r = tax.computeTds({ netPaisa: rs('100000'), category: 'professional_fee' });
  assert.equal(r.tdsPaisa, 1_500_000);
});

test('service contract TDS respects the annual threshold cumulatively', () => {
  const belowThreshold = tax.computeTds({ netPaisa: rs('40000'), category: 'service_contract' });
  assert.equal(belowThreshold.tdsPaisa, 0);
  assert.equal(belowThreshold.basis, 'below_annual_threshold');

  // Same payee, second bill: cumulative crosses Rs. 50,000 so TDS now applies.
  const crossing = tax.computeTds({
    netPaisa: rs('20000'),
    category: 'service_contract',
    priorPaymentsPaisa: rs('40000'),
  });
  assert.equal(crossing.tdsPaisa, 30_000); // 1.5% of Rs. 20,000 = Rs. 300.00
  assert.equal(crossing.basis, 'standard_rate');
});

test('an unknown TDS category throws instead of defaulting to zero', () => {
  assert.throws(
    () => tax.computeTds({ netPaisa: rs('1000'), category: 'made_up' }),
    tax.TaxError,
  );
});

test('TDS is computed on the VAT-exclusive value, never on gross', () => {
  const { vat, tds } = tax.computeTransactionTax({
    amountPaisa: rs('113000'),
    vatInclusive: true,
    tdsCategory: 'rent',
  });
  assert.equal(vat.netPaisa, 10_000_000);
  // 10% of the Rs.100,000 net, NOT of the Rs.113,000 gross.
  assert.equal(tds.tdsPaisa, 1_000_000);
});

test('period summary nets output VAT against input VAT', () => {
  const summary = tax.summarisePeriod([
    { kind: 'sale', netPaisa: rs('200000'), vatPaisa: rs('26000'), vatApplicable: true },
    { kind: 'sale', netPaisa: rs('100000'), vatPaisa: rs('13000'), vatApplicable: true },
    { kind: 'sale', netPaisa: rs('50000'), vatPaisa: 0, vatApplicable: false },
    { kind: 'purchase', netPaisa: rs('120000'), vatPaisa: rs('15600'), vatApplicable: true },
  ]);

  assert.equal(summary.taxableSalesPaisa, 30_000_000);
  assert.equal(summary.exemptSalesPaisa, 5_000_000);
  assert.equal(summary.outputVatPaisa, 3_900_000);
  assert.equal(summary.inputVatPaisa, 1_560_000);
  assert.equal(summary.netVatPaisa, 2_340_000);
  assert.equal(summary.position, 'payable');
});

test('more input than output VAT is reported as creditable, not as a negative payable', () => {
  const summary = tax.summarisePeriod([
    { kind: 'sale', netPaisa: rs('10000'), vatPaisa: rs('1300'), vatApplicable: true },
    { kind: 'purchase', netPaisa: rs('80000'), vatPaisa: rs('10400'), vatApplicable: true },
  ]);
  assert.equal(summary.position, 'creditable');
  assert.equal(summary.netVatPaisa, -910_000);
});
