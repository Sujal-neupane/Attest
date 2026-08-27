import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api, setTokens, clearTokens, hasSession, onSessionLost } from '../api/client.js';

const AuthContext = createContext(null);

/**
 * Who is signed in.
 *
 * The session is restored on load by asking the server who we are, rather than
 * by trusting a decoded token in localStorage. A token's claims tell you what
 * it says, not whether it is still valid — and a revoked or expired session
 * that still renders a dashboard is worse than one that sends you to sign in.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(hasSession() ? 'restoring' : 'signed-out');

  useEffect(() => {
    onSessionLost(() => {
      setUser(null);
      setStatus('signed-out');
    });
  }, []);

  useEffect(() => {
    if (status !== 'restoring') return;
    let cancelled = false;

    api
      .me()
      .then(({ user: me }) => {
        if (cancelled) return;
        setUser(me);
        setStatus('signed-in');
      })
      .catch(() => {
        if (cancelled) return;
        clearTokens();
        setStatus('signed-out');
      });

    return () => {
      cancelled = true;
    };
  }, [status]);

  const value = useMemo(
    () => ({
      user,
      status,
      async signIn(credentials) {
        const result = await api.login(credentials);
        setTokens(result);
        setUser(result.user);
        setStatus('signed-in');
        return result.user;
      },
      async register(details) {
        const result = await api.register(details);
        setTokens(result);
        setUser(result.user);
        setStatus('signed-in');
        return result.user;
      },
      signOut() {
        clearTokens();
        setUser(null);
        setStatus('signed-out');
      },
    }),
    [user, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
