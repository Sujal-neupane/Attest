import { useState } from 'react';

/**
 * Take the work away.
 *
 * The download goes through the authenticated API client rather than a plain
 * <a href>, because the export route requires a bearer token — a link the
 * browser follows on its own would arrive unauthenticated and 401.
 */

const EXPORTS = [
  ['vat-summary', 'VAT summary', 'The figures, for the IRD portal'],
  ['review-report', 'Review report', 'Every finding and who decided it'],
  ['transactions', 'Transactions', 'The full normalized ledger'],
];

export default function ExportBar({ periodId, download }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  async function run(kind) {
    setBusy(kind);
    setError(null);
    try {
      await download(periodId, kind);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="exports">
      <h3>Export</h3>
      {EXPORTS.map(([kind, label, hint]) => (
        <button
          key={kind}
          type="button"
          className="export"
          onClick={() => run(kind)}
          disabled={busy !== null}
        >
          <span className="export__label">{busy === kind ? 'Preparing…' : label}</span>
          <span className="export__hint">{hint}</span>
        </button>
      ))}
      {error && <p className="state state--error" role="alert">{error}</p>}
      <p className="exports__note">
        Working paper, not a filing. Nothing here is signed.
      </p>
    </section>
  );
}
