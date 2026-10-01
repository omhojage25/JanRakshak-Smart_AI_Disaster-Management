import { useEffect, useState } from 'react';
import { TrendingDown, Clock } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { fetchPredictions } from '../../lib/data';
import { RESOURCE_TYPE_CONFIG, STATUS_CONFIG, getEscalationTimeLeft } from '../../utils/helpers';

const WATCH_WINDOW_MIN = 20;

export function PredictionPanel() {
  const predictions = useStore((s) => s.predictions);
  const incidents = useStore((s) => s.incidents);
  const selectAndFlyTo = useStore((s) => s.selectAndFlyTo);
  const [, setTick] = useState(0);

  useEffect(() => {
    fetchPredictions().catch(() => {});
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // Recomputed on every render (the 30 s tick keeps it current); the list is small.
  const watch = incidents
    .filter((i) => (i.status === 'triage' || i.status === 'dispatched') && i.escalation_deadline && !i.parent_incident_id)
    .map((i) => ({ incident: i, left: getEscalationTimeLeft(i.escalation_deadline)! }))
    .filter((w) => w.left.minutes <= WATCH_WINDOW_MIN)
    .sort((a, b) => new Date(a.incident.escalation_deadline!).getTime() - new Date(b.incident.escalation_deadline!).getTime());

  return (
    <div className="space-y-3">
      <div className="bg-bg-inset border border-border rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <Clock className="w-4 h-4 text-danger" />
          <span className="text-xs font-medium">Escalation watch</span>
          <span className="text-[10px] text-text-dim ml-auto">next {WATCH_WINDOW_MIN} min</span>
        </div>
        {watch.length === 0 ? (
          <div className="text-xs text-text-dim py-1">No incidents are close to their response deadline.</div>
        ) : (
          <ul className="space-y-1.5">
            {watch.map(({ incident, left }) => (
              <li key={incident.id}>
                <button
                  onClick={() => selectAndFlyTo(incident.id, incident.location_lat, incident.location_lng)}
                  className="w-full text-left text-xs flex items-center gap-2 hover:bg-bg-card-hover rounded px-1 py-0.5 cursor-pointer"
                >
                  <span className="flex-1 truncate text-text-muted">{incident.title}</span>
                  <span className="text-[10px]" style={{ color: STATUS_CONFIG[incident.status].color }}>{STATUS_CONFIG[incident.status].label}</span>
                  <span className="font-medium whitespace-nowrap" style={{ color: left.color }}>{left.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[10px] text-text-dim mt-2">Overdue incidents are escalated automatically every 30 s and everyone is notified.</p>
      </div>

      <div className="bg-bg-inset border border-border rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <TrendingDown className="w-4 h-4 text-warning" />
          <span className="text-xs font-medium">Resource burndown</span>
        </div>
        {predictions.length === 0 && <div className="text-xs text-text-dim text-center py-2">No predictions available</div>}
        {predictions.map((p) => {
          const cfg = RESOURCE_TYPE_CONFIG[p.resource_type];
          const isCritical = p.risk_level === 'critical' || p.risk_level === 'high';
          const isWarning = p.risk_level === 'moderate';
          const exhaustMin = p.projected_exhaustion_minutes;
          return (
            <div key={p.resource_type} className="mb-2 last:mb-0">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1"><span>{cfg?.icon}</span><span>{cfg?.label}</span></span>
                <span className={`font-medium ${isCritical ? 'text-danger' : isWarning ? 'text-warning' : 'text-success'}`}>
                  {exhaustMin === 0 ? 'EXHAUSTED' : exhaustMin != null ? `~${exhaustMin}m left` : 'Stable'}
                </span>
              </div>
              <div className="flex items-center gap-1 mt-1">
                <div className="flex-1 h-1.5 bg-bg rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${p.utilization_pct}%`, background: isCritical ? '#ef4444' : isWarning ? '#eab308' : '#22c55e' }}
                  />
                </div>
                <span className="text-[10px] text-text-dim">{p.available}/{p.total} free</span>
              </div>
              <p className="text-[10px] text-text-dim mt-0.5">{p.recommendation}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
