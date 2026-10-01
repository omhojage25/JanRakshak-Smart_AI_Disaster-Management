import { useEffect, useState } from 'react';
import { FileText, AlertCircle, CheckCircle, Truck, Plus, LogIn, GitMerge, Zap, Flag, XCircle } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { fetchAuditLog } from '../../lib/data';
import { setAuditFeedVisible } from '../../lib/realtime';
import { formatTimeAgo } from '../../utils/helpers';

const ACTION_STYLE: Record<string, { icon: typeof FileText; color: string }> = {
  created: { icon: Plus, color: '#3b82f6' },
  created_from_report: { icon: Plus, color: '#3b82f6' },
  merged: { icon: GitMerge, color: '#8b5cf6' },
  updated: { icon: FileText, color: '#eab308' },
  status_changed: { icon: Flag, color: '#f59e0b' },
  escalated: { icon: AlertCircle, color: '#ef4444' },
  approved: { icon: CheckCircle, color: '#22c55e' },
  completed: { icon: CheckCircle, color: '#22c55e' },
  en_route: { icon: Truck, color: '#3b82f6' },
  arrived: { icon: Truck, color: '#a855f7' },
  rejected: { icon: XCircle, color: '#ef4444' },
  cancelled: { icon: XCircle, color: '#ef4444' },
  ai_recommendation: { icon: Zap, color: '#06b6d4' },
  login: { icon: LogIn, color: '#64748b' },
};

function summary(details: Record<string, unknown>): string | null {
  const s = (k: string) => (typeof details[k] === 'string' ? (details[k] as string) : null);
  if (s('from') && s('to')) return `${s('from')!.replace('_', ' ')} → ${s('to')!.replace('_', ' ')}`;
  return s('resource_name') ?? s('title') ?? s('message') ?? s('username') ?? null;
}

export function AuditLog() {
  const auditLog = useStore((s) => s.auditLog);
  const [error, setError] = useState('');

  useEffect(() => {
    setAuditFeedVisible(true);
    fetchAuditLog().catch((err) => setError((err as Error).message));
    return () => setAuditFeedVisible(false);
  }, []);

  return (
    <div className="bg-bg-inset border border-border rounded-lg p-3">
      <div className="text-xs font-medium mb-2">Audit trail</div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {auditLog.length === 0 && !error && <div className="text-xs text-text-dim text-center py-4">No audit entries</div>}
      <div className="space-y-2 max-h-[32rem] overflow-y-auto">
        {auditLog.slice(0, 100).map((entry) => {
          const style = ACTION_STYLE[entry.action] ?? { icon: FileText, color: '#94a3b8' };
          const Icon = style.icon;
          const text = summary(entry.details ?? {});
          return (
            <div key={entry.id} className="flex gap-2 text-xs">
              <Icon className="w-3 h-3 flex-shrink-0 mt-0.5" style={{ color: style.color }} />
              <div className="min-w-0">
                <div className="text-text-muted">
                  <span className="capitalize font-medium" style={{ color: style.color }}>{entry.action.replace(/_/g, ' ')}</span>{' '}
                  {entry.entity_type}
                </div>
                {text && <p className="text-[10px] text-text-dim truncate">{text}</p>}
                <span className="text-[10px] text-text-dim">{formatTimeAgo(entry.created_at)} · {entry.user_name ?? 'System'}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
