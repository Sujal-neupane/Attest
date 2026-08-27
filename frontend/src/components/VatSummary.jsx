import { formatPaisa } from '../lib/money.js';

/**
 * The VAT position.
 *
 * The one place this product could most easily mislead someone, so it states
 * its own status plainly: whether every figure has been computed, whether
 * findings are still open, and — always — that nothing here is final until an
 * accountant signs. A summary that looked authoritative while flags were open
 * would be the single most dangerous screen in the application.
 */

const STATUS = {
  incomplete: { label: 'Incomplete', tone: 'warn', note: 'Some entries have no computed figure yet.' },
  pending_review: { label: 'Pending review', tone: 'warn', note: 'Findings are still open.' },
  ready_for_review: { label: 'Ready for your review', tone: 'ok', note: 'Every finding has been cleared.' },
};

export default function VatSummary({ summary }) {
  if (!summary) return null;
  const status = STATUS[summary.status] ?? STATUS.pending_review;

  const rows = [
    ['Taxable sales', summary.taxableSalesPaisa],
    ['Exempt sales', summary.exemptSalesPaisa],
    ['Taxable purchases', summary.taxablePurchasesPaisa],
  ];

  return (
    <section className="summary" aria-labelledby="summary-heading">
      <h2 id="summary-heading">VAT position</h2>

      <p className={`status status--${status.tone}`}>
        <strong>{status.label}.</strong> {status.note}
      </p>

      <table className="summary__table">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className="money">{formatPaisa(value)}</td>
            </tr>
          ))}
          <tr className="summary__rule">
            <th scope="row">Output VAT</th>
            <td className="money">{formatPaisa(summary.outputVatPaisa)}</td>
          </tr>
          <tr>
            <th scope="row">Input VAT</th>
            <td className="money">{formatPaisa(summary.inputVatPaisa)}</td>
          </tr>
          <tr className="summary__total">
            <th scope="row">
              {summary.position === 'creditable' ? 'Creditable' : 'Payable'}
            </th>
            <td className="money">{formatPaisa(Math.abs(summary.netVatPaisa))}</td>
          </tr>
        </tbody>
      </table>

      {summary.uncomputedCount > 0 && (
        <p className="summary__caveat" role="alert">
          {summary.uncomputedCount} entries have no computed figure and are excluded
          from these totals. Run reconciliation again.
        </p>
      )}

      <p className="summary__disclaimer">{summary.disclaimer}</p>
    </section>
  );
}
