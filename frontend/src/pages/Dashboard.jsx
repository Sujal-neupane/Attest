import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { formatDate, pluralise } from '../lib/money.js';

/**
 * Clients, periods, and getting documents into one.
 *
 * The upload step is where the Doherty Threshold bites: parsing genuinely takes
 * seconds, so this reports honest staged progress rather than a spinner. A
 * spinner with no information is what makes a ten-second wait feel like a
 * failure.
 */

const DOC_TYPES = [
  ['bank_statement', 'Bank statement'],
  ['sales_register', 'Sales register'],
  ['purchase_register', 'Purchase register'],
];

export default function Dashboard() {
  const navigate = useNavigate();
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState(null);
  const [periods, setPeriods] = useState([]);
  const [activePeriod, setActivePeriod] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    api.listClients().then(setClients).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.listPeriods(selected.id).then(setPeriods).catch((err) => setError(err.message));
  }, [selected]);

  /**
   * Poll while anything is still parsing, and stop as soon as it is not.
   *
   * The interval is cleared on unmount and whenever the period changes; a poll
   * left running against a period nobody is looking at is a request every two
   * seconds forever.
   */
  const pollStatus = useCallback((periodId) => {
    clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const next = await api.periodStatus(periodId);
        setStatus(next);
        if (next.pending === 0) clearInterval(pollRef.current);
      } catch {
        clearInterval(pollRef.current);
      }
    };
    tick();
    pollRef.current = setInterval(tick, 2000);
  }, []);

  useEffect(() => () => clearInterval(pollRef.current), []);

  useEffect(() => {
    if (activePeriod) pollStatus(activePeriod.id);
    else {
      clearInterval(pollRef.current);
      setStatus(null);
    }
  }, [activePeriod, pollStatus]);

  async function addClient(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    setBusy(true);
    setError(null);
    try {
      const created = await api.createClient({
        name: form.get('name'),
        pan: form.get('pan') || undefined,
      });
      setClients((current) => [...current, created]);
      event.target.reset();
    } catch (err) {
      setError(err.fields?.[0]?.message ?? err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addPeriod(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    setBusy(true);
    setError(null);
    try {
      // Only a Bikram Sambat year and month are asked for. The Gregorian range
      // is derived server-side from the verified calendar table, so nobody has
      // to convert dates by hand — which is exactly the error-prone work this
      // product exists to remove.
      const created = await api.createPeriod(selected.id, {
        bsYear: Number(form.get('bsYear')),
        bsMonth: form.get('bsMonth') ? Number(form.get('bsMonth')) : undefined,
      });
      setPeriods((current) => [created, ...current]);
      setActivePeriod(created);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(event) {
    const file = event.target.files?.[0];
    const type = event.target.dataset.type;
    if (!file || !activePeriod) return;

    setBusy(true);
    setError(null);
    try {
      await api.uploadDocument(activePeriod.id, file, type);
      pollStatus(activePeriod.id);
    } catch (err) {
      setError(err.detail ? `${err.message} ${err.detail}` : err.message);
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function reconcile() {
    setBusy(true);
    setError(null);
    try {
      await api.reconcile(activePeriod.id);
      navigate(`/periods/${activePeriod.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard">
      {error && <p className="state state--error" role="alert">{error}</p>}

      <section className="panel">
        <h2>Clients</h2>
        <ul className="list">
          {clients.map((client) => (
            <li key={client.id}>
              <button
                type="button"
                className={`list__item ${selected?.id === client.id ? 'list__item--on' : ''}`}
                onClick={() => {
                  setSelected(client);
                  setActivePeriod(null);
                }}
              >
                <span>{client.name}</span>
                {client.pan && <span className="tabular muted">PAN {client.pan}</span>}
              </button>
            </li>
          ))}
          {clients.length === 0 && <li className="muted">No clients yet.</li>}
        </ul>

        <form className="inline-form" onSubmit={addClient}>
          <input className="field__input" name="name" placeholder="Business name" required />
          <input className="field__input" name="pan" placeholder="PAN (9 digits)" inputMode="numeric" />
          <button className="button" disabled={busy}>Add client</button>
        </form>
      </section>

      {selected && (
        <section className="panel">
          <h2>{selected.name} — periods</h2>
          <ul className="list">
            {periods.map((period) => (
              <li key={period.id}>
                <button
                  type="button"
                  className={`list__item ${activePeriod?.id === period.id ? 'list__item--on' : ''}`}
                  onClick={() => setActivePeriod(period)}
                >
                  <span>{period.label}</span>
                  <span className="tabular muted">
                    {formatDate(period.startDate)} – {formatDate(period.endDate)}
                  </span>
                </button>
              </li>
            ))}
            {periods.length === 0 && <li className="muted">No periods yet.</li>}
          </ul>

          <form className="inline-form" onSubmit={addPeriod}>
            <input className="field__input" name="bsYear" placeholder="BS year, e.g. 2081" required />
            <input className="field__input" name="bsMonth" placeholder="BS month 1–12 (optional)" />
            <button className="button" disabled={busy}>Add period</button>
          </form>
          <p className="field__hint">
            Leave the month blank for a full fiscal year (Shrawan to Ashadh). The
            Gregorian dates are worked out for you.
          </p>
        </section>
      )}

      {activePeriod && (
        <section className="panel">
          <h2>{activePeriod.label} — documents</h2>

          <div className="uploads">
            {DOC_TYPES.map(([type, label]) => (
              <label key={type} className="upload">
                <input type="file" accept=".csv,text/csv" data-type={type} onChange={upload} hidden />
                <span className="upload__label">{label}</span>
                <span className="upload__hint">CSV</span>
              </label>
            ))}
          </div>

          {status && (
            <div className="progress">
              <p>
                {pluralise(status.documents, 'document')} ·{' '}
                {status.pending > 0
                  ? `${pluralise(status.pending, 'still parsing')}…`
                  : `${pluralise(status.transactionCount, 'transaction')} imported`}
              </p>

              {status.failed.length > 0 && (
                <ul className="failures">
                  {status.failed.map((failure) => (
                    <li key={failure.id}>
                      <strong>{failure.filename}</strong> could not be read. {failure.reason}
                    </li>
                  ))}
                </ul>
              )}

              {status.ready && status.transactionCount > 0 && (
                <button className="button button--primary" onClick={reconcile} disabled={busy}>
                  {busy ? 'Reconciling…' : 'Reconcile and review'}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
