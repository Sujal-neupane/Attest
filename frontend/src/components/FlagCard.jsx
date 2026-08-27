import { useState } from 'react';
import { formatPaisa, formatDate } from '../lib/money.js';

/**
 * One finding, and the decision it needs.
 *
 * Design notes, each answering something in docs/BRAND.md:
 *
 * HICK'S LAW — exactly three actions: Accept, Dismiss, Add note. Not a dropdown
 * of twelve dispositions. A reviewer working a hundred flags makes the same
 * three-way decision a hundred times and should never re-read the options.
 *
 * FITTS'S LAW — those actions sit at the same offset inside every card, at
 * 40px minimum height, so the hand learns one location.
 *
 * MILLER'S LAW — the figure, the date, the party, the reason and the source are
 * all inline. The reviewer never has to hold a number in their head while
 * navigating elsewhere to check it.
 *
 * WCAG 1.4.1 — severity is carried by an icon shape and a text label as well as
 * colour, so it survives both a monochrome print and colour-vision deficiency.
 */

const SEVERITY = {
  high: { label: 'High', shape: '▲', hint: 'Money is wrong or at risk' },
  medium: { label: 'Medium', shape: '◆', hint: 'Needs explanation before filing' },
  low: { label: 'Low', shape: '●', hint: 'Worth a glance' },
};

const TYPE_LABELS = {
  duplicate_invoice: 'Duplicate invoice',
  missing_bill: 'Missing bill',
  round_number: 'Round figure',
  invoice_gap: 'Invoice gap',
  anomaly: 'Discrepancy',
};

export default function FlagCard({ flag, selected, onSelect, onResolve, onViewSource, busy }) {
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [error, setError] = useState(null);

  const severity = SEVERITY[flag.severity] ?? SEVERITY.low;
  const isOpen = flag.status === 'open';

  // Dismissing a high-severity finding requires a written reason — enforced by
  // the database and the API. Surfaced here so the requirement is visible
  // BEFORE the click rather than as an error afterwards.
  const needsReason = flag.severity === 'high';
  const reasonTooShort = needsReason && note.trim().length < 10;

  async function resolve(status) {
    setError(null);
    if (status === 'dismissed' && reasonTooShort) {
      setShowNote(true);
      setError('Dismissing a high-severity finding needs a written reason.');
      return;
    }
    try {
      await onResolve(flag.id, { status, note: note.trim() || undefined });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <article
      className={`flag flag--${flag.severity} ${selected ? 'flag--selected' : ''} ${
        isOpen ? '' : 'flag--resolved'
      }`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect?.(flag.id)}
    >
      <header className="flag__head">
        <span className={`badge badge--${flag.severity}`}>
          <span aria-hidden="true">{severity.shape}</span>
          <span>{severity.label}</span>
          {/* The hint is for anyone who has not learned the scale yet. */}
          <span className="visually-hidden"> severity — {severity.hint}</span>
        </span>
        <span className="flag__type">{TYPE_LABELS[flag.type] ?? flag.type}</span>

        {flag.amountPaisa != null && (
          <span className={`money flag__amount ${flag.amountPaisa < 0 ? 'money--negative' : ''}`}>
            {formatPaisa(flag.amountPaisa, { withSymbol: true })}
          </span>
        )}
      </header>

      <p className="flag__message">{flag.message}</p>

      {flag.suggestion && (
        <p className="flag__suggestion">
          {/* AI-drafted text is labelled as such. A reviewer must always know
              whether a machine wrote the sentence they are reading. */}
          {flag.aiDrafted && <span className="tag tag--ai">Drafted by AI</span>}
          {flag.suggestion}
        </p>
      )}

      <dl className="flag__meta">
        {flag.txnDate && (
          <>
            <dt>Date</dt>
            <dd className="tabular">{formatDate(flag.txnDate, flag.bsDateLabel)}</dd>
          </>
        )}
        {flag.party && (
          <>
            <dt>Party</dt>
            <dd>{flag.party}</dd>
          </>
        )}
        {flag.invoiceNumber && (
          <>
            <dt>Invoice</dt>
            <dd className="tabular">{flag.invoiceNumber}</dd>
          </>
        )}
      </dl>

      {flag.documentId && (
        <button
          type="button"
          className="link"
          onClick={(event) => {
            event.stopPropagation();
            onViewSource(flag);
          }}
        >
          View source · {flag.documentFilename}
          {flag.sourceRef?.row ? `, line ${flag.sourceRef.row}` : ''}
        </button>
      )}

      {isOpen ? (
        <div className="flag__actions" onClick={(event) => event.stopPropagation()}>
          {showNote && (
            <label className="field">
              <span className="field__label">
                Note {needsReason && <em>— required to dismiss</em>}
              </span>
              <textarea
                className="field__input"
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What did you check, and what did you conclude?"
                autoFocus
              />
            </label>
          )}

          {error && <p className="flag__error" role="alert">{error}</p>}

          <div className="flag__buttons">
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => resolve('accepted')}
            >
              Accept
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => resolve('dismissed')}
            >
              Dismiss
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setShowNote((open) => !open)}
              aria-expanded={showNote}
            >
              {showNote ? 'Hide note' : 'Add note'}
            </button>
          </div>
        </div>
      ) : (
        <p className="flag__resolution">
          {/* 'superseded' is a system action, not a person's decision, and is
              worded so it never reads as though someone signed it off. */}
          <strong>
            {flag.status === 'accepted' && 'Accepted'}
            {flag.status === 'dismissed' && 'Dismissed'}
            {flag.status === 'superseded' && 'Superseded by a later run'}
          </strong>
          {flag.resolvedByName ? ` by ${flag.resolvedByName}` : ''}
          {flag.resolvedAt ? ` on ${String(flag.resolvedAt).slice(0, 10)}` : ''}
          {flag.resolvedNote && flag.status !== 'superseded' && (
            <span className="flag__note">“{flag.resolvedNote}”</span>
          )}
        </p>
      )}
    </article>
  );
}
