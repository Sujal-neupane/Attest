import { useEffect, useRef } from 'react';

/**
 * The original document, beside the finding.
 *
 * Opens as a side panel rather than a new page, deliberately: the reviewer must
 * be able to compare the figure against its source without losing the finding
 * they were reading. That is Miller's Law — do not make someone hold a number
 * in working memory while they navigate away to check it.
 *
 * Provenance is the product's central claim, and this panel is where the claim
 * is either honoured or exposed as marketing.
 */
export default function SourceViewer({ source, onClose }) {
  const closeRef = useRef(null);

  // Focus moves into the panel when it opens, so a keyboard user is not left
  // behind in the list, and Escape is handled by the page.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const { flag, url, loading, error } = source;
  const line = flag.sourceRef?.row;

  return (
    <aside className="viewer" role="dialog" aria-modal="false" aria-label="Source document">
      <header className="viewer__head">
        <div>
          <h2>{flag.documentFilename}</h2>
          {line && <p className="viewer__line tabular">Line {line}</p>}
        </div>
        <button ref={closeRef} type="button" className="button button--quiet" onClick={onClose}>
          Close
        </button>
      </header>

      {loading && <p className="state">Decrypting the original…</p>}
      {error && <p className="state state--error" role="alert">{error}</p>}

      {url && (
        <>
          {/* The raw text of what the client actually sent. The figure on the
              flag was derived from this; showing anything prettier would put a
              layer of our own interpretation between the two. */}
          <iframe className="viewer__frame" src={url} title={flag.documentFilename} />
          <p className="viewer__hint">
            This is the file exactly as uploaded. Every figure on the left was
            read from it.
          </p>
        </>
      )}

      {flag.sourceRef?.raw && (
        <dl className="viewer__raw">
          <p className="viewer__raw-title">As written on that line</p>
          {Object.entries(flag.sourceRef.raw).map(([field, value]) => (
            <div key={field}>
              <dt>{field}</dt>
              <dd className="tabular">{String(value) || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
    </aside>
  );
}
