import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Shield, Loader2, AlertTriangle } from 'lucide-react';
import { useAuth } from '../store/useAuth';
import { ApiError } from '../lib/http';

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError && err.offline
        ? 'Cannot reach the server. Check your connection and try again.'
        : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-text placeholder-text-dim focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent';

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-bg-card border border-border rounded-2xl p-6 space-y-4 shadow-2xl">
        <div className="flex flex-col items-center gap-2 pb-2">
          <div className="w-12 h-12 rounded-xl bg-accent flex items-center justify-center">
            <Shield className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-xl font-semibold">JanRakshak</h1>
          <p className="text-xs text-text-dim">AI disaster response coordination</p>
        </div>

        <div className="space-y-1">
          <label htmlFor="username" className="text-xs text-text-muted">Username</label>
          <input id="username" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} className={input} required autoFocus />
        </div>
        <div className="space-y-1">
          <label htmlFor="password" className="text-xs text-text-muted">Password</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} required />
        </div>

        {error && (
          <div className="flex items-start gap-2 p-2 bg-danger/10 border border-danger/30 rounded-lg text-xs text-danger">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
          </div>
        )}

        <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-white rounded-lg font-medium hover:bg-accent-hover transition-colors disabled:opacity-50 cursor-pointer">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Sign in
        </button>
        <p className="text-center text-xs text-text-dim">
          Staff only. Reporting an emergency?{' '}
          <Link to="/public-report" className="text-accent hover:underline">
            Send a report without signing in
          </Link>
        </p>
      </form>
    </div>
  );
}
