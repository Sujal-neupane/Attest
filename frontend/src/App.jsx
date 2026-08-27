import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { Logo } from './components/Logo.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Review from './pages/Review.jsx';

function Protected({ children }) {
  const { status } = useAuth();
  const location = useLocation();

  // 'restoring' is its own state, distinct from signed-out. Redirecting to the
  // login screen while a session is still being verified would sign people out
  // every time they refreshed.
  if (status === 'restoring') return <p className="state">Checking your session…</p>;
  if (status !== 'signed-in') return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

function Shell({ children }) {
  const { user, signOut, status } = useAuth();

  return (
    <>
      <header className="topbar">
        <Link to="/" className="topbar__brand" aria-label="Attest home">
          <Logo size={28} />
        </Link>

        {status === 'signed-in' && (
          <div className="topbar__user">
            <span className="topbar__name">{user?.email}</span>
            <span className="topbar__role">{user?.role}</span>
            <button type="button" className="button button--quiet" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </header>
      <main className="page">{children}</main>
      <footer className="footer">
        <p>Attest prepares. The accountant attests. Nothing here is filed or signed.</p>
      </footer>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Protected><Dashboard /></Protected>} />
          <Route path="/periods/:periodId" element={<Protected><Review /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </AuthProvider>
  );
}
