import { useEffect, useState } from 'react';
import { CloudOff, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import { IntakeForm } from '../components/intake/IntakeForm';
import { discardPending, flushQueue, listPending, PENDING_CHANGED_EVENT, type PendingReport } from '../lib/offlineQueue';
import { formatTimeAgo } from '../utils/helpers';
import { useStore } from '../store/useStore';

function PendingReports() {
  const [items, setItems] = useState<PendingReport[]>([]);
  const [syncing, setSyncing] = useState(false);
  const connection = useStore((s) => s.connection);

  useEffect(() => {
    const load = () => listPending().then(setItems).catch(() => setItems([]));
    load();
    window.addEventListener(PENDING_CHANGED_EVENT, load);
    return () => window.removeEventListener(PENDING_CHANGED_EVENT, load);
  }, []);

  if (items.length === 0) return null;

  const retry = async () => {
    setSyncing(true);
    try {
      await flushQueue();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="bg-bg-card border border-warning/30 rounded-xl p-3 sm:p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-warning">
          <CloudOff className="w-4 h-4" /> Saved on this device ({items.length})
        </div>
        <button
          onClick={retry}
          disabled={syncing || connection === 'offline'}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border border-border hover:border-accent disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> Upload now
        </button>
      </div>
      <p className="text-[11px] text-text-dim">These upload automatically when the connection returns. Do not clear this browser’s site data until they are sent.</p>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.client_id} className="py-2 flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-text line-clamp-2">{item.raw_message}</p>
              <p className="text-[10px] text-text-dim mt-0.5">
                Saved {formatTimeAgo(item.queued_at)}{item.attempts > 0 ? ` · ${item.attempts} upload attempt${item.attempts > 1 ? 's' : ''}` : ''}
              </p>
              {item.failed && (
                <p className="text-[10px] text-danger flex items-center gap-1 mt-0.5">
                  <AlertTriangle className="w-3 h-3" /> Rejected by the server: {item.last_error}
                </p>
              )}
            </div>
            <button
              onClick={() => { if (window.confirm('Discard this saved report? It has not been sent.')) void discardPending(item.client_id); }}
              className="p-1.5 rounded hover:bg-bg-card-hover cursor-pointer"
              aria-label="Discard saved report"
            >
              <Trash2 className="w-4 h-4 text-text-dim" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReportPage() {
  return (
    <div className="p-3 sm:p-4 max-w-5xl mx-auto space-y-4">
      <PendingReports />
      <div className="bg-bg-card border border-border rounded-xl p-3 sm:p-4">
        <IntakeForm />
      </div>
    </div>
  );
}
