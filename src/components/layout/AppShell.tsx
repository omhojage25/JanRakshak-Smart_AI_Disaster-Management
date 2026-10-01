import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Shield, LayoutDashboard, FilePlus2, Radio, Users, LogOut, CloudOff, Wifi, Loader2, Menu, X, KeyRound } from 'lucide-react';
import { useAuth } from '../../store/useAuth';
import { useStore } from '../../store/useStore';
import { ROLE_LABEL } from '../../utils/helpers';
import { NotificationBar } from '../shared/NotificationBar';
import { Toasts } from '../shared/Toasts';
import { ChangePasswordDialog } from '../shared/ChangePasswordDialog';
import type { Role } from '../../types';

const NAV: { to: string; label: string; icon: typeof Shield; roles: Role[] }[] = [
  { to: '/', label: 'Command Center', icon: LayoutDashboard, roles: ['admin', 'coordinator'] },
  { to: '/report', label: 'New report', icon: FilePlus2, roles: ['admin', 'coordinator', 'field_reporter'] },
  { to: '/field', label: 'Field unit', icon: Radio, roles: ['field_reporter', 'admin'] },
  { to: '/admin/users', label: 'Users', icon: Users, roles: ['admin'] },
];

function ConnectionBadge() {
  const connection = useStore((s) => s.connection);
  const offlineSession = useAuth((s) => s.offlineSession);
  const pending = useStore((s) => s.pendingReports);

  const offline = offlineSession || connection === 'offline';
  return (
    <div className="flex items-center gap-2">
      {pending > 0 && (
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-warning/15 text-warning border border-warning/30 whitespace-nowrap" title="Reports saved on this device, waiting to upload">
          {pending} queued
        </span>
      )}
      <span
        className={`flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-md border whitespace-nowrap ${
          offline
            ? 'bg-danger/10 text-danger border-danger/30'
            : connection === 'connected'
              ? 'bg-success/10 text-success border-success/30'
              : 'bg-warning/10 text-warning border-warning/30'
        }`}
        title={offline ? 'No connection to the server' : connection === 'connected' ? 'Live updates active' : 'Reconnecting'}
      >
        {offline ? <CloudOff className="w-3 h-3" /> : connection === 'connected' ? <Wifi className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
        <span className="hidden sm:inline">{offline ? 'Offline' : connection === 'connected' ? 'Live' : 'Reconnecting'}</span>
      </span>
    </div>
  );
}

export function AppShell() {
  const user = useAuth((s) => s.user)!;
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const links = NAV.filter((n) => n.roles.includes(user.role));

  const handleLogout = async () => {
    setMenuOpen(false);
    await logout().catch(() => {});
    navigate('/login', { replace: true });
  };

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `relative flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${
      isActive ? 'text-text bg-bg-card-hover' : 'text-text-muted hover:text-text hover:bg-bg-card-hover/60'
    }`;

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border bg-bg-secondary/95 backdrop-blur-sm sticky top-0 z-[1100]">
        <div className="max-w-[2200px] mx-auto px-3 sm:px-4 h-14 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="md:hidden p-2 -ml-1 rounded-lg hover:bg-bg-card-hover cursor-pointer"
              aria-label="Menu"
            >
              {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center flex-shrink-0">
              <Shield className="w-[18px] h-[18px] text-white" />
            </div>
            <div className="leading-tight min-w-0">
              <h1 className="text-[15px] font-semibold text-text truncate">JanRakshak</h1>
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-accent hidden sm:block md:hidden lg:block">Emergency response</div>
            </div>
            <nav aria-label="Main" className="hidden md:flex items-center gap-1 ml-2 lg:ml-4">
              {links.map((l) => (
                <NavLink key={l.to} to={l.to} end={l.to === '/'} className={navClass}>
                  <l.icon className="w-4 h-4" />
                  {l.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-1 sm:gap-2">
            <ConnectionBadge />
            <NotificationBar />
            <div className="hidden md:flex items-center gap-2 pl-2 border-l border-border">
              <div className="text-right leading-tight hidden lg:block">
                <div className="text-xs font-medium">{user.full_name}</div>
                <div className="text-[10px] text-text-dim">{ROLE_LABEL[user.role]}</div>
              </div>
              <button onClick={() => setPasswordOpen(true)} className="p-2 rounded-lg hover:bg-bg-card-hover cursor-pointer" title="Change password">
                <KeyRound className="w-4 h-4 text-text-muted" />
              </button>
              <button onClick={handleLogout} className="p-2 rounded-lg hover:bg-bg-card-hover cursor-pointer" title="Sign out">
                <LogOut className="w-4 h-4 text-text-muted" />
              </button>
            </div>
          </div>
        </div>

        {menuOpen && (
          <div className="md:hidden border-t border-border px-3 py-2 space-y-1 bg-bg-card">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.to === '/'} className={navClass} onClick={() => setMenuOpen(false)}>
                <l.icon className="w-4 h-4" />
                {l.label}
              </NavLink>
            ))}
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-border">
              <div className="text-xs">
                <div className="font-medium">{user.full_name}</div>
                <div className="text-text-dim">{ROLE_LABEL[user.role]}</div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => { setMenuOpen(false); setPasswordOpen(true); }} className="flex items-center gap-1 px-3 py-2 text-xs rounded-lg border border-border cursor-pointer">
                  <KeyRound className="w-4 h-4" /> Password
                </button>
                <button onClick={handleLogout} className="flex items-center gap-1 px-3 py-2 text-xs rounded-lg border border-border cursor-pointer">
                  <LogOut className="w-4 h-4" /> Sign out
                </button>
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="max-w-[2200px] mx-auto">
        <Outlet />
      </main>
      <Toasts />
      {passwordOpen && <ChangePasswordDialog onClose={() => setPasswordOpen(false)} />}
    </div>
  );
}
