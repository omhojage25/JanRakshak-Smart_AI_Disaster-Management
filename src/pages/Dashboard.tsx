import { useEffect, useState } from 'react';
import { AlertTriangle, Radio } from 'lucide-react';
import { useStore } from '../store/useStore';
import { useAuth } from '../store/useAuth';
import { IncidentFeed } from '../components/dashboard/IncidentFeed';
import { SituationMap } from '../components/map/SituationMap';
import { IncidentDetail } from '../components/dashboard/IncidentDetail';
import { ResponseOverview } from '../components/dashboard/ResponseOverview';
import { Segmented, Spinner } from '../components/ui/primitives';
import { cx } from '../utils/cx';
import { useActiveIncidents } from '../lib/operations';

/** Below this width the three columns collapse into tabs (tablet keeps the map beside one panel). */
const WIDE = '(min-width: 1024px)';

type View = 'queue' | 'map' | 'response';

export function Dashboard() {
  const selectedIncidentId = useStore((s) => s.selectedIncidentId);
  const mapPick = useStore((s) => s.mapPick);
  const loaded = useStore((s) => s.loaded);
  const error = useStore((s) => s.error);
  const offlineSession = useAuth((s) => s.offlineSession);
  const [view, setView] = useState<View>('queue');

  // On narrow screens, jump to the panel that the user's action is about.
  useEffect(() => {
    if (selectedIncidentId && !window.matchMedia(WIDE).matches) setView('response');
  }, [selectedIncidentId]);
  useEffect(() => {
    if (mapPick && !window.matchMedia('(min-width: 768px)').matches) setView('map');
  }, [mapPick]);

  if (!loaded) {
    return (
      <div className="p-8 flex flex-col items-center gap-3 text-sm text-text-muted">
        {offlineSession || error ? (
          <>
            <AlertTriangle className="w-6 h-6 text-warning" />
            <p className="text-center max-w-sm">
              {offlineSession
                ? 'You are offline. Live data will load when the connection returns. You can still file reports from "New report".'
                : `Could not load data: ${error}`}
            </p>
          </>
        ) : (
          <Spinner className="w-6 h-6" />
        )}
      </div>
    );
  }

  const rightLabel = selectedIncidentId ? 'Incident' : 'Response';

  return (
    <div className="h-[calc(100dvh-3.5rem)] flex flex-col">
      <div className="px-3 pt-3 lg:hidden">
        <Segmented
          label="Command center panels"
          className="md:hidden"
          value={view}
          onChange={setView}
          options={[{ value: 'queue', label: 'Incidents' }, { value: 'map', label: 'Map' }, { value: 'response', label: rightLabel }]}
        />
        <Segmented
          label="Command center panels"
          className="hidden md:flex"
          value={view === 'response' ? 'response' : 'queue'}
          onChange={setView}
          options={[{ value: 'queue', label: 'Incidents' }, { value: 'response', label: rightLabel }]}
        />
      </div>

      <div className="flex-1 min-h-0 grid gap-3 p-3 grid-cols-1 grid-rows-1 md:grid-cols-[minmax(0,1fr)_340px] lg:grid-cols-[minmax(250px,19%)_minmax(0,1fr)_minmax(340px,24%)] 2xl:grid-cols-[minmax(280px,18%)_minmax(0,1fr)_minmax(380px,22%)]">
        <aside
          aria-label="Priority incidents"
          className={cx(
            'min-h-0 flex-col bg-bg-card border border-border rounded-xl overflow-hidden md:col-start-2 md:row-start-1 lg:col-start-1',
            view === 'queue' ? 'flex' : 'hidden',
            view !== 'response' ? 'md:flex' : 'md:hidden',
            'lg:flex',
          )}
        >
          <IncidentFeed />
        </aside>

        <div
          className={cx(
            'min-h-[320px] rounded-xl overflow-hidden border border-border md:col-start-1 md:row-start-1 lg:col-start-2',
            view === 'map' ? 'flex' : 'hidden', 'md:flex',
          )}
        >
          <SituationMap />
        </div>

        <aside
          aria-label={selectedIncidentId ? 'Selected incident' : 'Response overview'}
          className={cx(
            'min-h-0 flex-col bg-bg-card border border-border rounded-xl overflow-hidden md:col-start-2 md:row-start-1 lg:col-start-3',
            view === 'response' ? 'flex md:flex' : 'hidden md:hidden',
            'lg:flex',
          )}
        >
          {selectedIncidentId ? <IncidentDetail key={selectedIncidentId} incidentId={selectedIncidentId} /> : <ResponseOverview />}
        </aside>
      </div>

      <StatusStrip />
    </div>
  );
}

/** Slim footer with live counts and connection state. */
function StatusStrip() {
  const active = useActiveIncidents();
  const resources = useStore((s) => s.resources);
  const connection = useStore((s) => s.connection);
  const dataVersion = useStore((s) => s.dataVersion);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const [, setTick] = useState(0);

  useEffect(() => { setUpdatedAt(new Date()); }, [dataVersion]);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, []);

  const critical = active.filter((i) => i.priority === 'critical').length;
  const ready = resources.filter((r) => r.status === 'available' && ['ambulance', 'fire_truck', 'police', 'road_crew'].includes(r.type)).length;
  const secs = Math.round((Date.now() - updatedAt.getTime()) / 1000);

  return (
    <footer className="hidden sm:flex items-center gap-4 px-4 h-8 border-t border-border bg-bg-secondary text-[11px] text-text-dim">
      <span>Last update: {secs < 20 ? 'just now' : secs < 3600 ? `${Math.round(secs / 60) || 1} min ago` : updatedAt.toLocaleTimeString()}</span>
      <span>Active incidents: <b className="text-text font-semibold tabular-nums">{active.length}</b></span>
      {critical > 0 && <span>Critical: <b className="text-red-300 font-semibold tabular-nums">{critical}</b></span>}
      <span>Units ready: <b className="text-text font-semibold tabular-nums">{ready}</b></span>
      <span className={cx('ml-auto inline-flex items-center gap-1.5', connection === 'connected' ? 'text-success' : 'text-warning')}>
        <Radio className="w-3 h-3" />
        {connection === 'connected' ? 'Live link connected' : connection === 'connecting' ? 'Reconnecting live link…' : 'Live link offline'}
      </span>
    </footer>
  );
}
