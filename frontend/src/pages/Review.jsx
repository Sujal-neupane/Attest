import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, fetchSourceBlobUrl } from '../api/client.js';
import FlagCard from '../components/FlagCard.jsx';
import VatSummary from '../components/VatSummary.jsx';
import SourceViewer from '../components/SourceViewer.jsx';
import { pluralise } from '../lib/money.js';

/**
 * The review sheet — the screen this product exists for.
 *
 * The reviewer's whole job happens here: work down a list of findings, check
 * each against its source, and decide. Everything below serves that loop.
 *
 * KEYBOARD FIRST. Anyone who uses this daily will not reach for a mouse a
 * hundred times an hour. J/K move, A accepts, D dismisses, V opens the source,
 * Escape closes it. Fitts's Law says the fastest target is the one you do not
 * have to travel to at all.
 */

const SHORTCUTS = [
  ['J / ↓', 'Next finding'],
  ['K / ↑', 'Previous finding'],
  ['A', 'Accept'],
  ['D', 'Dismiss'],
  ['V', 'View source'],
  ['Esc', 'Close source'],
];

export default function Review() {
  const { periodId } = useParams();

  const [flags, setFlags] = useState([]);
  const [summary, setSummary] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [source, setSource] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);

  const listRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextFlags, nextSummary] = await Promise.all([
        api.flags(periodId),
        api.vatSummary(periodId),
      ]);
      setFlags(nextFlags);
      setSummary(nextSummary);
      setSelectedId((current) =>
        current && nextFlags.some((f) => f.id === current)
          ? current
          : (nextFlags.find((f) => f.status === 'open')?.id ?? null),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [periodId]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(
    () => (showResolved ? flags : flags.filter((f) => f.status === 'open')),
    [flags, showResolved],
  );

  const openCount = flags.filter((f) => f.status === 'open').length;
  const highCount = flags.filter((f) => f.status === 'open' && f.severity === 'high').length;

  const resolve = useCallback(
    async (flagId, body) => {
      setBusy(true);
      try {
        const updated = await api.resolveFlag(flagId, body);

        // Optimistic-feeling but server-confirmed: the row is replaced with what
        // the server actually stored, so the note and attribution shown are the
        // recorded ones rather than what we hoped they would be.
        setFlags((current) => current.map((f) => (f.id === flagId ? { ...f, ...updated } : f)));

        // Move to the next open finding so the reviewer keeps their place in the
        // list rather than being bounced back to the top.
        const remaining = visible.filter((f) => f.id !== flagId && f.status === 'open');
        setSelectedId(remaining[0]?.id ?? null);

        // The summary's counts change with every decision.
        api.vatSummary(periodId).then(setSummary).catch(() => {});
      } finally {
        setBusy(false);
      }
    },
    [visible, periodId],
  );

  const viewSource = useCallback(async (flag) => {
    setSource({ loading: true, flag });
    try {
      const url = await fetchSourceBlobUrl(flag.documentId);
      setSource({ loading: false, flag, url });
    } catch (err) {
      setSource({ loading: false, flag, error: err.message });
    }
  }, []);

  const closeSource = useCallback(() => {
    setSource((current) => {
      // Blob URLs hold the decrypted document in memory until revoked. Letting
      // them accumulate would keep a client's bank statements alive in the tab
      // for as long as it stays open.
      if (current?.url) URL.revokeObjectURL(current.url);
      return null;
    });
  }, []);

  // ---- Keyboard --------------------------------------------------------
  useEffect(() => {
    function onKeyDown(event) {
      // Never steal a keystroke from someone typing a note.
      const tag = event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.metaKey || event.ctrlKey) {
        if (event.key === 'Escape') closeSource();
        return;
      }

      const index = visible.findIndex((f) => f.id === selectedId);
      const current = visible[index];

      switch (event.key.toLowerCase()) {
        case 'j':
        case 'arrowdown':
          event.preventDefault();
          setSelectedId(visible[Math.min(index + 1, visible.length - 1)]?.id ?? selectedId);
          break;
        case 'k':
        case 'arrowup':
          event.preventDefault();
          setSelectedId(visible[Math.max(index - 1, 0)]?.id ?? selectedId);
          break;
        case 'a':
          if (current?.status === 'open') resolve(current.id, { status: 'accepted' });
          break;
        case 'd':
          // Deliberately NOT wired to a bare keystroke for high severity: those
          // require a written reason, and a one-key dismissal of the findings
          // that matter most is precisely the habit this product should not
          // build. The card's button handles it, with the note visible.
          if (current?.status === 'open' && current.severity !== 'high') {
            resolve(current.id, { status: 'dismissed' });
          }
          break;
        case 'v':
          if (current?.documentId) viewSource(current);
          break;
        case 'escape':
          closeSource();
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, selectedId, resolve, viewSource, closeSource]);

  // Keep the selected card in view when moving by keyboard.
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const node = listRef.current.querySelector(`[data-flag-id="${selectedId}"]`);
    node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  if (loading) return <p className="state">Loading the review sheet…</p>;
  if (error) return <p className="state state--error" role="alert">{error}</p>;

  return (
    <div className={`review ${source ? 'review--split' : ''}`}>
      <div className="review__main">
        <header className="review__head">
          <div>
            <h1>{summary?.period?.label ?? 'Review'}</h1>
            <p className="review__dates tabular">
              {summary?.period?.startDate} to {summary?.period?.endDate}
            </p>
          </div>

          <div className="review__counts">
            {openCount === 0 ? (
              <span className="pill pill--clear">Nothing left to review</span>
            ) : (
              <>
                <span className="pill">{pluralise(openCount, 'open finding')}</span>
                {highCount > 0 && (
                  <span className="pill pill--high">{highCount} high severity</span>
                )}
              </>
            )}
          </div>
        </header>

        <div className="review__toolbar">
          <label className="toggle">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(event) => setShowResolved(event.target.checked)}
            />
            Show resolved
          </label>

          <details className="shortcuts">
            <summary>Keyboard</summary>
            <dl>
              {SHORTCUTS.map(([key, meaning]) => (
                <div key={key}>
                  <dt><kbd>{key}</kbd></dt>
                  <dd>{meaning}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            <p className="empty__title">Every finding has been reviewed.</p>
            <p>
              The figures are prepared. They are not filed and not signed — that
              is still yours to do.
            </p>
          </div>
        ) : (
          <div className="review__list" ref={listRef}>
            {visible.map((flag) => (
              <div key={flag.id} data-flag-id={flag.id}>
                <FlagCard
                  flag={flag}
                  selected={flag.id === selectedId}
                  busy={busy}
                  onSelect={setSelectedId}
                  onResolve={resolve}
                  onViewSource={viewSource}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <aside className="review__side">
        <VatSummary summary={summary} />
      </aside>

      {source && <SourceViewer source={source} onClose={closeSource} />}
    </div>
  );
}
