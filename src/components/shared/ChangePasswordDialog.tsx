import { useState, type FormEvent } from 'react';
import { X, Loader2 } from 'lucide-react';
import { api } from '../../lib/http';

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== confirm) {
      setError('The new passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: { current_password: current, new_password: next } });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent';

  return (
    <div className="fixed inset-0 z-[1300] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm bg-bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Change password</h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-bg-card-hover cursor-pointer" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        {done ? (
          <>
            <p className="text-sm text-success">Password updated. Other devices signed in to this account have been signed out.</p>
            <button type="button" onClick={onClose} className="w-full px-3 py-2 bg-accent text-white rounded-lg text-sm cursor-pointer">Done</button>
          </>
        ) : (
          <>
            <input type="password" autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} required />
            <input type="password" autoComplete="new-password" placeholder="New password (min. 8 characters)" value={next} onChange={(e) => setNext(e.target.value)} className={input} minLength={8} required />
            <input type="password" autoComplete="new-password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} minLength={8} required />
            {error && <p className="text-xs text-danger">{error}</p>}
            <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent text-white rounded-lg text-sm disabled:opacity-50 cursor-pointer">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Update password
            </button>
          </>
        )}
      </form>
    </div>
  );
}
