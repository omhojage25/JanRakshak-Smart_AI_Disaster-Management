import { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowRightLeft, CheckCircle2, ChevronRight, Copy, MapPinOff, ShieldCheck, Timer, Truck,
} from 'lucide-react';
import { useStore } from '../../store/useStore';
import { actionItems, useActiveIncidents, useIncidentOps, type ActionKind } from '../../lib/operations';
import { INCIDENT_TYPE_CONFIG, PRIORITY_CONFIG, RESOURCE_TYPE_CONFIG } from '../../utils/helpers';
import { EmptyState, SectionHeader, Segmented, Stat } from '../ui/primitives';
import { cx } from '../../utils/cx';
import { ResourcePanel } from './ResourcePanel';
import { PredictionPanel } from './PredictionPanel';
import { AuditLog } from './AuditLog';

type Tab = 'overview' | 'resources' | 'forecast' | 'audit';

const MOBILE_TYPES = ['ambulance', 'fire_truck', 'police', 'road_crew'];

const ACTION_ICON: Record<ActionKind, { icon: typeof Activity; cls: string }> = {
  reallocation: { icon: ArrowRightLeft, cls: 'text-blue-300' },
  approval: { icon: CheckCircle2, cls: 'text-blue-300' },
  duplicate: { icon: Copy, cls: 'text-warning' },
  location: { icon: MapPinOff, cls: 'text-warning' },
  overdue: { icon: Timer, cls: 'text-red-300' },
};

const UNIT_STATUS: Record<string, string> = { dispatched: 'Dispatched', en_route: 'En route', arrived: 'On scene' };

/** Right-hand panel when no incident is selected: what needs attention and who is responding. */
export function ResponseOverview() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-3 pt-3 pb-2 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold">Response overview</h2>
        </div>
        <Segmented
          label="Overview sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'resources', label: 'Resources' },
            { value: 'forecast', label: 'Forecast' },
            { value: 'audit', label: 'Audit' },
          ]}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'overview' && <Overview />}
        {tab === 'resources' && <div className="p-3"><ResourcePanel /></div>}
        {tab === 'forecast' && <div className="p-3"><PredictionPanel /></div>}
        {tab === 'audit' && <div className="p-3"><AuditLog /></div>}
      </div>
    </div>
  );
}

function Overview() {
  const incidents = useActiveIncidents();
  const ops = useIncidentOps();
  const resources = useStore((s) => s.resources);
  const assignments = useStore((s) => s.assignments);
  const selectAndFlyTo = useStore((s) => s.selectAndFlyTo);
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const items = useMemo(() => actionItems(incidents, ops), [incidents, ops]);
  const units = resources.filter((r) => MOBILE_TYPES.includes(r.type));
  const available = units.filter((r) => r.status === 'available').length;
  const deployed = units.filter((r) => r.status === 'dispatched' || r.status === 'en_route' || r.status === 'on_scene').length;
  const unavailable = units.filter((r) => r.status === 'unavailable').length;
  const awaiting = assignments.filter((a) => a.status === 'recommended' && ops.has(a.incident_id)).length;
  const responding = incidents.filter((i) => (ops.get(i.id)?.active.length ?? 0) > 0);
  const byId = useMemo(() => new Map(resources.map((r) => [r.id, r])), [resources]);

  const go = (id: string) => {
    const i = incidents.find((x) => x.id === id);
    selectAndFlyTo(id, i?.location_lat, i?.location_lng);
  };

  return (
    <div className="p-3 space-y-5">
      <div className="grid grid-cols-2 gap-x-3 gap-y-4 p-3 rounded-lg bg-bg-inset border border-border">
        <Stat label="Action required" value={items.length} tone={items.length ? 'text-warning' : 'text-text'} hint="Decisions waiting for a coordinator" />
        <Stat label="Awaiting approval" value={awaiting} tone={awaiting ? 'text-blue-300' : 'text-text'} hint="Unit proposals not yet approved" />
        <Stat label="Units deployed" value={deployed} tone="text-sky-300" />
        <Stat label="Units available" value={available} tone={available ? 'text-success' : 'text-danger'} hint={unavailable ? `${unavailable} out of service` : undefined} />
      </div>

      <section className="space-y-2">
        <SectionHeader icon={<AlertTriangle />} title="Action required" meta={items.length ? `${items.length}` : undefined} />
        {items.length === 0 ? (
          <p className="text-xs text-text-dim px-1">Nothing waiting for a decision.</p>
        ) : (
          <ul className="space-y-1">
            {items.slice(0, 12).map((it) => {
              const Icon = ACTION_ICON[it.kind].icon;
              return (
                <li key={it.key}>
                  <button
                    type="button"
                    onClick={() => go(it.incident.id)}
                    className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left hover:bg-bg-card-hover cursor-pointer border border-transparent hover:border-border"
                  >
                    <Icon className={cx('w-4 h-4 flex-shrink-0', ACTION_ICON[it.kind].cls)} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-text truncate">{it.label}</div>
                      <div className="text-[11px] text-text-dim truncate">
                        <span style={{ color: PRIORITY_CONFIG[it.incident.priority].color }}>{PRIORITY_CONFIG[it.incident.priority].label}</span>
                        {' · '}{it.incident.title}
                      </div>
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-text-dim flex-shrink-0" />
                  </button>
                </li>
              );
            })}
            {items.length > 12 && <li className="text-[11px] text-text-dim px-2">+{items.length - 12} more in the incident queue</li>}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <SectionHeader icon={<Truck />} title="Active responses" meta={responding.length ? `${responding.length}` : undefined} />
        {responding.length === 0 ? (
          <EmptyState title="No units are responding right now" className="py-3" />
        ) : (
          <ul className="space-y-1.5">
            {responding.map((incident) => {
              const o = ops.get(incident.id)!;
              return (
                <li key={incident.id}>
                  <button
                    type="button"
                    onClick={() => go(incident.id)}
                    className="w-full text-left p-2.5 rounded-lg bg-bg-inset border border-border hover:border-border-light cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <span aria-hidden>{INCIDENT_TYPE_CONFIG[incident.type].icon}</span>
                      <span className="text-xs font-semibold truncate flex-1">{incident.title}</span>
                      {o.nextEtaMin != null && <span className="text-[11px] text-sky-300 whitespace-nowrap tabular-nums">ETA {o.nextEtaMin} min</span>}
                    </div>
                    <ul className="mt-1.5 space-y-0.5">
                      {o.active.map((a) => {
                        const r = byId.get(a.resource_id);
                        return (
                          <li key={a.id} className="flex items-center gap-1.5 text-[11px] text-text-muted">
                            <span aria-hidden>{r ? RESOURCE_TYPE_CONFIG[r.type].icon : '•'}</span>
                            <span className="truncate flex-1">{r?.name ?? a.resource_name}</span>
                            <span className={cx('whitespace-nowrap', a.status === 'arrived' ? 'text-success' : 'text-text-dim')}>{UNIT_STATUS[a.status]}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
