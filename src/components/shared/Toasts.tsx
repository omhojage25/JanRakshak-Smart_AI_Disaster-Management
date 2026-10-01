import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, AlertCircle, Info, CheckCircle, X } from 'lucide-react';
import { useStore, type Toast } from '../../store/useStore';
import { useAuth } from '../../store/useAuth';

const STYLE = {
  critical: { icon: AlertTriangle, color: '#ef4444', ttl: 15_000 },
  warning: { icon: AlertCircle, color: '#eab308', ttl: 10_000 },
  info: { icon: Info, color: '#3b82f6', ttl: 6_000 },
  success: { icon: CheckCircle, color: '#22c55e', ttl: 6_000 },
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s.dismissToast);
  const navigate = useNavigate();
  const role = useAuth((s) => s.user?.role);
  const cfg = STYLE[toast.type];
  const Icon = cfg.icon;

  useEffect(() => {
    const t = window.setTimeout(() => dismiss(toast.id), cfg.ttl);
    return () => window.clearTimeout(t);
  }, [toast.id, cfg.ttl, dismiss]);

  const open = () => {
    dismiss(toast.id);
    if (!toast.incident_id || role === 'field_reporter') return;
    const incident = useStore.getState().incidents.find((i) => i.id === toast.incident_id);
    useStore.getState().selectAndFlyTo(toast.incident_id, incident?.location_lat, incident?.location_lng);
    navigate('/');
  };

  return (
    <div
      role="alert"
      className="pointer-events-auto w-full sm:w-96 bg-bg-card border rounded-xl shadow-2xl p-3 flex gap-3 animate-[toast-in_0.2s_ease-out]"
      style={{ borderColor: `${cfg.color}66` }}
    >
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: cfg.color }} />
      <button onClick={open} className="flex-1 min-w-0 text-left cursor-pointer">
        <div className="text-sm font-semibold">{toast.title}</div>
        <div className="text-xs text-text-muted mt-0.5 line-clamp-3">{toast.message}</div>
      </button>
      <button onClick={() => dismiss(toast.id)} className="p-1 h-fit rounded hover:bg-bg-card-hover cursor-pointer" aria-label="Dismiss">
        <X className="w-4 h-4 text-text-dim" />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="fixed z-[1200] bottom-3 left-3 right-3 sm:left-auto sm:right-4 sm:bottom-4 flex flex-col gap-2 items-stretch sm:items-end pointer-events-none">
      {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
    </div>
  );
}
