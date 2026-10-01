import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loader2, UserPlus, Trash2, KeyRound } from 'lucide-react';
import { usersApi } from '../lib/data';
import { useAuth } from '../store/useAuth';
import { useStore } from '../store/useStore';
import { ROLE_LABEL, formatTimeAgo } from '../utils/helpers';
import type { ManagedUser, Role } from '../types';

const ROLES: Role[] = ['admin', 'coordinator', 'field_reporter'];
const inputCls = 'w-full bg-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent';

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const resources = useStore((s) => s.resources);
  const [form, setForm] = useState({ username: '', full_name: '', password: '', role: 'coordinator' as Role, resource_id: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await usersApi.create({ ...form, resource_id: form.role === 'field_reporter' && form.resource_id ? form.resource_id : null });
      setForm({ username: '', full_name: '', password: '', role: 'coordinator', resource_id: '' });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-bg-card border border-border rounded-xl p-4 space-y-3">
      <h2 className="text-sm font-semibold flex items-center gap-2"><UserPlus className="w-4 h-4" /> Add user</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input className={inputCls} placeholder="Username" autoCapitalize="none" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
        <input className={inputCls} placeholder="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
        <input className={inputCls} type="password" autoComplete="new-password" placeholder="Temporary password (min. 8)" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        {form.role === 'field_reporter' && (
          <select className={`${inputCls} sm:col-span-2`} value={form.resource_id} onChange={(e) => setForm({ ...form, resource_id: e.target.value })}>
            <option value="">Linked unit (for GPS tracking) — none</option>
            {resources.filter((r) => ['ambulance', 'fire_truck', 'police', 'road_crew'].includes(r.type)).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <button type="submit" disabled={busy} className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm disabled:opacity-50 cursor-pointer">
        {busy && <Loader2 className="w-4 h-4 animate-spin" />} Create user
      </button>
    </form>
  );
}

export function AdminUsersPage() {
  const me = useAuth((s) => s.user)!;
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    usersApi.list().then(setUsers).catch((err) => setError((err as Error).message));
  }, []);

  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const resetPassword = (u: ManagedUser) => {
    const password = window.prompt(`New password for ${u.username} (min. 8 characters). They will be signed out everywhere.`);
    if (password) void act(() => usersApi.update(u.id, { password }));
  };

  return (
    <div className="p-3 sm:p-4 max-w-5xl mx-auto space-y-4">
      <CreateUserForm onCreated={load} />
      <div className="bg-bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-sm font-semibold">Users</div>
        {error && <p className="px-4 pt-3 text-xs text-danger">{error}</p>}
        {!users ? (
          <div className="p-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-accent" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="text-[11px] text-text-dim uppercase">
                <tr className="border-b border-border">
                  <th className="text-left font-medium px-4 py-2">User</th>
                  <th className="text-left font-medium px-4 py-2">Role</th>
                  <th className="text-left font-medium px-4 py-2">Unit</th>
                  <th className="text-left font-medium px-4 py-2">Last sign-in</th>
                  <th className="text-left font-medium px-4 py-2">Active</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === me.id;
                  return (
                    <tr key={u.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">
                        <div className="font-medium">{u.full_name}{self && <span className="text-[10px] text-text-dim"> (you)</span>}</div>
                        <div className="text-[11px] text-text-dim">{u.username}</div>
                      </td>
                      <td className="px-4 py-2">
                        <select
                          value={u.role}
                          disabled={self}
                          onChange={(e) => void act(() => usersApi.update(u.id, { role: e.target.value as Role }))}
                          className="bg-bg border border-border rounded px-2 py-1 text-xs disabled:opacity-60"
                        >
                          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-2 text-xs text-text-muted">{u.resource_name ?? '—'}</td>
                      <td className="px-4 py-2 text-xs text-text-muted">{u.last_login_at ? formatTimeAgo(u.last_login_at) : 'Never'}</td>
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={u.active}
                          disabled={self}
                          onChange={(e) => void act(() => usersApi.update(u.id, { active: e.target.checked }))}
                          className="accent-accent cursor-pointer"
                          aria-label={`${u.username} active`}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => resetPassword(u)} className="p-1.5 rounded hover:bg-bg-card-hover cursor-pointer" title="Reset password">
                            <KeyRound className="w-4 h-4 text-text-muted" />
                          </button>
                          {!self && (
                            <button
                              onClick={() => { if (window.confirm(`Delete ${u.username}? Their audit history is kept.`)) void act(() => usersApi.remove(u.id)); }}
                              className="p-1.5 rounded hover:bg-bg-card-hover cursor-pointer"
                              title="Delete user"
                            >
                              <Trash2 className="w-4 h-4 text-text-muted" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
