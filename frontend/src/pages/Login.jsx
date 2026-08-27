import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Logo } from '../components/Logo.jsx';

export default function Login() {
  const { signIn, register, status } = useAuth();
  const location = useLocation();
  const [mode, setMode] = useState('sign-in');
  const [form, setForm] = useState({ email: '', password: '', firmName: '', fullName: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (status === 'signed-in') return <Navigate to={location.state?.from?.pathname ?? '/'} replace />;

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'sign-in') await signIn({ email: form.email, password: form.password });
      else await register(form);
    } catch (err) {
      // The server's message is shown as written: it is already phrased for the
      // person reading it, and a generic "login failed" would throw that away.
      setError(err.fields?.[0]?.message ?? err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth__card">
        <Logo size={36} />
        <p className="auth__tagline">
          Prepare a client&rsquo;s VAT return from their own documents.
        </p>

        <form onSubmit={submit}>
          {mode === 'register' && (
            <>
              <label className="field">
                <span className="field__label">Firm name</span>
                <input className="field__input" value={form.firmName} onChange={update('firmName')} required />
              </label>
              <label className="field">
                <span className="field__label">Your name</span>
                <input className="field__input" value={form.fullName} onChange={update('fullName')} required />
              </label>
            </>
          )}

          <label className="field">
            <span className="field__label">Email</span>
            <input
              className="field__input"
              type="email"
              autoComplete="username"
              value={form.email}
              onChange={update('email')}
              required
            />
          </label>

          <label className="field">
            <span className="field__label">Password</span>
            <input
              className="field__input"
              type="password"
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              value={form.password}
              onChange={update('password')}
              required
            />
            {mode === 'register' && (
              <span className="field__hint">
                At least 12 characters — this account holds client financial data.
              </span>
            )}
          </label>

          {error && <p className="state state--error" role="alert">{error}</p>}

          <button type="submit" className="button button--primary button--block" disabled={busy}>
            {busy ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create firm account'}
          </button>
        </form>

        <button
          type="button"
          className="link auth__switch"
          onClick={() => {
            setMode(mode === 'sign-in' ? 'register' : 'sign-in');
            setError(null);
          }}
        >
          {mode === 'sign-in' ? 'Set up a new firm account' : 'I already have an account'}
        </button>
      </div>
    </div>
  );
}
