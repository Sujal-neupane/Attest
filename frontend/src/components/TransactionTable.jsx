import { formatPaisa, formatDate } from '../lib/money.js';

/**
 * The normalized ledger.
 *
 * JAKOB'S LAW — accountants live in Excel, so this is a table: sortable-looking
 * headers, money right-aligned in tabular figures, the source named on every
 * row. Fighting that habit would be arrogance.
 *
 * Reported and computed figures sit in adjacent columns on purpose. Keeping
 * them apart in the database is only useful if somebody can see both at once.
 */
export default function TransactionTable({ transactions }) {
  if (!transactions?.length) {
    return <p className="state">No transactions in this period yet.</p>;
  }

  return (
    <div className="table-wrap">
      {transactions.meta?.truncated && (
        <p className="state state--error" role="alert">
          Showing {transactions.meta.returned} of {transactions.meta.total} transactions.
        </p>
      )}

      <table className="table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Source</th>
            <th scope="col">Party</th>
            <th scope="col">Invoice</th>
            <th scope="col" className="table__num">Amount</th>
            <th scope="col" className="table__num">Reported VAT</th>
            <th scope="col" className="table__num">Computed VAT</th>
            <th scope="col">From</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((txn) => {
            // A difference between what the books say and what the law says is
            // the thing an accountant is looking for, so it is marked in the
            // row rather than left to be spotted by comparing two columns.
            const mismatch =
              txn.reportedVatPaisa != null &&
              txn.vatPaisa != null &&
              Math.abs(txn.reportedVatPaisa - txn.vatPaisa) > 2;

            return (
              <tr key={txn.id} className={mismatch ? 'table__row--flagged' : ''}>
                <td className="tabular">{formatDate(txn.txnDate, txn.bsDateLabel)}</td>
                <td>
                  <span className={`chip chip--${txn.source}`}>{txn.source}</span>
                </td>
                <td>{txn.party || <span className="muted">{txn.description}</span>}</td>
                <td className="tabular">{txn.invoiceNumber || '—'}</td>
                <td className={`money ${txn.amountPaisa < 0 ? 'money--negative' : ''}`}>
                  {formatPaisa(txn.amountPaisa)}
                </td>
                <td className="money">{formatPaisa(txn.reportedVatPaisa)}</td>
                <td className={`money ${mismatch ? 'money--negative' : ''}`}>
                  {formatPaisa(txn.vatPaisa)}
                </td>
                <td className="muted table__source">
                  {txn.documentFilename}
                  {txn.sourceRef?.row ? `:${txn.sourceRef.row}` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
