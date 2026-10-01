import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './store/useAuth';
import { useStore } from './store/useStore';
import { connectRealtime, disconnectRealtime } from './lib/realtime';
import { startAutoSync } from './lib/offlineQueue';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './pages/LoginPage';
import { Dashboard } from './pages/Dashboard';
import { ReportPage } from './pages/ReportPage';
import { FieldPage } from './pages/FieldPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { PublicReportPage } from './pages/PublicReportPage';
import { TrackPage } from './pages/TrackPage';
import type { Role } from './types';

function homeFor(role: Role) {
  return role === 'field_reporter' ? '/field' : '/';
}

function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const user = useAuth((s) => s.user);
  if (!user) return null;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

export default function App() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const offlineSession = useAuth((s) => s.offlineSession);
  const location = useLocation();

  useEffect(() => {
    useAuth.getState().checkSession();
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') return;
    const stopSync = startAutoSync();
    if (!offlineSession) connectRealtime();
    return () => {
      stopSync();
      disconnectRealtime();
    };
  }, [status, offlineSession]);

  // An offline session becomes a real one as soon as the server is reachable again.
  useEffect(() => {
    if (!offlineSession) return;
    const retry = () => useAuth.getState().checkSession();
    window.addEventListener('online', retry);
    const interval = window.setInterval(retry, 15_000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(interval);
    };
  }, [offlineSession]);

  useEffect(() => {
    if (status === 'anonymous') useStore.getState().reset();
  }, [status]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
      </div>
    );
  }

  if (status === 'anonymous' || !user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/public-report" element={<PublicReportPage />} />
        <Route path="/track/:incidentId" element={<TrackPage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to={homeFor(user.role)} replace />} />
      <Route path="/public-report" element={<PublicReportPage />} />
      <Route path="/track/:incidentId" element={<TrackPage />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<RequireRole roles={['admin', 'coordinator']}><Dashboard /></RequireRole>} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/field" element={<RequireRole roles={['field_reporter', 'admin']}><FieldPage /></RequireRole>} />
        <Route path="/admin/users" element={<RequireRole roles={['admin']}><AdminUsersPage /></RequireRole>} />
        <Route path="*" element={<Navigate to={homeFor(user.role)} replace />} />
      </Route>
    </Routes>
  );
}
