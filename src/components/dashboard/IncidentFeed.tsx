import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Clock, Copy, MapPin, Truck, Users, ListChecks, Search } from 'lucide-react';
import { useStore, isActiveStatus, type FeedView } from '../../store/useStore';
import { useIncidentOps, opsFor } from '../../lib/operations';
import {
  INCIDENT_TYPE_CONFIG, PRIORITY_CONFIG, compareOperational, formatTimeAgo, getEscalationTimeLeft, locationQuality,
} from '../../utils/helpers';
import { EmptyState, SeverityBadge, StatusBadge } from '../ui/primitives';
import { cx } from '../../utils/cx';
import type { Incident, Priority } from '../../types';

const VIEWS: { key: FeedView; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
];

type Vulnerable = 'children' | 'elderly' | 'disabled';

/** The coordinator's operational queue: most urgent first, with what each incident needs next. */
export function IncidentFeed() {
  const incidents = useStore((s) => s.incidents);
  const assignments = useStore((s) => s.assignments);
  const priorityFilter = useStore((s) => s.priorityFilter);
  const setPriorityFilter = useStore((s) => s.setPriorityFilter);
  const feedView = useStore((s) => s.feedView);
  const setFeedView = useStore((s) => s.setFeedView);
  const selectedId = useStore((s) => s.selectedIncidentId);
  const selectAndFlyTo = useStore((s) => s.selectAndFlyTo);
  const activeOps = useIncidentOps();
  const [vulnerable, setVulnerable] = useState<Vulnerable | null>(null);
  const [query, setQuery] = useState('');
  const [, setTick] = useState(0);

  // Keeps escalation countdowns moving.
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const counts = useMemo(() => {
    const c = { active: 0, resolved: 0, closed: 0 };
    for (const i of incidents) {
      if (i.parent_incident_id) continue;
      if (isActiveStatus(i.status)) c.active += 1;
      else if (i.status === 'resolved') c.resolved += 1;
      else if (i.status === 'closed') c.closed += 1;
    }
    return c;
  }, [incidents]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = incidents.filter((i) => !i.parent_incident_id && (feedView === 'active' ? isActiveStatus(i.status) : i.status === feedView));
    if (priorityFilter) out = out.filter((i) => i.priority === priorityFilter);
    if (vulnerable) out = out.filter((i) => (vulnerable === 'children' ? i.has_children : vulnerable === 'elderly' ? i.has_elderly : i.has_disabled));
    if (q) out = out.filter((i) => `${i.title} ${i.location_name ?? ''} ${INCIDENT_TYPE_CONFIG[i.type]?.label}`.toLowerCase().includes(q));
    return feedView === 'active'
      ? [...out].sort(compareOperational)
      : [...out].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  }, [incidents, priorityFilter, vulnerable, feedView, query]);

  const critical = list.filter((i) => i.priority === 'critical').length;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-3 pt-3 pb-2 space-y-2 border-b border-border">
        <div className="flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-danger" />
          <h2 className="text-sm font-semibold">Priority incidents</h2>
          {feedView === 'active' && critical > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-danger/15 text-red-300 border border-danger/30">{critical} CRITICAL</span>
          )}
          <span className="ml-auto text-[11px] text-text-dim">{list.length} shown</span>
        </div>

        <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-inset border border-border" role="tablist" aria-label="Incident status">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              role="tab"
              aria-selected={feedView === v.key}
              onClick={() => setFeedView(v.key)}
              className={cx('flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
                feedView === v.key ? 'bg-bg-card-hover text-text' : 'text-text-dim hover:text-text')}
            >
              {v.label} <span className="opacity-60 tabular-nums">{counts[v.key]}</span>
            </button>
          ))}
        </div>

        <div className="flex gap-0.5" role="group" aria-label="Filter by severity">
          <Chip active={!priorityFilter} onClick={() => setPriorityFilter(null)}>All</Chip>
          {(['critical', 'high', 'medium', 'low'] as Priority[]).map((p) => (
            <Chip key={p} active={priorityFilter === p} color={PRIORITY_CONFIG[p].color} onClick={() => setPriorityFilter(priorityFilter === p ? null : p)}>
              {PRIORITY_CONFIG[p].label}
            </Chip>
          ))}
        </div>

        <div className="flex gap-1.5">
          <label className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-bg-inset border border-border focus-within:border-accent">
            <Search className="w-3.5 h-3.5 text-text-dim flex-shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search incidents by title or location"
              className="flex-1 min-w-0 bg-transparent text-xs text-text placeholder-text-dim focus:outline-none"
            />
          </label>
          <select
            value={vulnerable ?? ''}
            onChange={(e) => setVulnerable((e.target.value || null) as Vulnerable | null)}
            aria-label="Filter by vulnerable people"
            className="bg-bg-inset border border-border rounded-lg px-2 text-xs text-text-muted focus:outline-none focus:border-accent cursor-pointer"
          >
            <option value="">Anyone</option>
            <option value="children">Children</option>
            <option value="elderly">Elderly</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
        {list.map((incident) => (
          <IncidentCard
            key={incident.id}
            incident={incident}
            ops={activeOps.get(incident.id) ?? opsFor(incident, assignments)}
            selected={selectedId === incident.id}
            onClick={() => {
              const next = selectedId === incident.id ? null : incident.id;
              selectAndFlyTo(next, next ? incident.location_lat : undefined, next ? incident.location_lng : undefined);
            }}
          />
        ))}
        {list.length === 0 && (
          <EmptyState icon={<ListChecks />} title={feedView === 'active' && !priorityFilter && !vulnerable && !query ? 'No active incidents' : `No ${feedView} incidents match`}>
            {feedView === 'active' && !priorityFilter && !vulnerable && !query && 'New reports appear here automatically.'}
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function IncidentCard({ incident, ops, selected, onClick }: {
  incident: Incident; ops: ReturnType<typeof opsFor>; selected: boolean; onClick: () => void;
}) {
  const cfg = INCIDENT_TYPE_CONFIG[incident.type];
  const pCfg = PRIORITY_CONFIG[incident.priority];
  const active = isActiveStatus(incident.status);
  const esc = active ? getEscalationTimeLeft(incident.escalation_deadline) : null;
  const loc = locationQuality(incident);
  const needsAction = active && (ops.proposals.length > 0 || ops.duplicatePending || ops.locationCheck || ops.overdue);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        'group w-full text-left rounded-lg border pl-3 pr-2.5 py-2.5 cursor-pointer transition-colors relative overflow-hidden',
        selected ? 'bg-accent/10 border-accent/60' : 'bg-bg-inset border-border hover:bg-bg-card-hover hover:border-border-light',
      )}
    >
      <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: pCfg.color, opacity: active ? 1 : 0.4 }} aria-hidden />
      <div className="flex items-start gap-2">
        <span className="text-base leading-none mt-0.5" aria-hidden>{cfg?.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="text-[13px] font-semibold text-text leading-snug line-clamp-2 flex-1">{incident.title}</div>
            {needsAction && <span className="mt-1 w-2 h-2 rounded-full bg-warning flex-shrink-0" title="Coordinator action needed" />}
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <SeverityBadge priority={incident.priority} />
            <StatusBadge status={incident.status} />
            <span className="text-[11px] text-text-dim">{cfg?.label}</span>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-text-muted mt-1.5 min-w-0">
            <MapPin className="w-3 h-3 flex-shrink-0 text-text-dim" />
            <span className="truncate">{incident.location_name || 'Unknown location'}</span>
          </div>
          <div className="flex items-center gap-x-3 gap-y-1 text-[11px] text-text-dim mt-1 flex-wrap">
            {incident.people_affected > 0 && <span className="inline-flex items-center gap-1"><Users className="w-3 h-3" />{incident.people_affected} affected</span>}
            {active && ops.active.length > 0 && (
              <span className="inline-flex items-center gap-1 text-sky-300">
                <Truck className="w-3 h-3" />{ops.active.length} unit{ops.active.length > 1 ? 's' : ''}{ops.nextEtaMin != null ? ` · ETA ${ops.nextEtaMin}m` : ''}
              </span>
            )}
            {incident.corroborating_reports > 1 && <span className="inline-flex items-center gap-1"><Copy className="w-3 h-3" />{incident.corroborating_reports} reports</span>}
            <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{formatTimeAgo(incident.created_at)}</span>
          </div>
          {active && (ops.proposals.length > 0 || ops.duplicatePending || loc.needsVerification || esc?.minutes === 0) && (
            <div className="flex gap-1 flex-wrap mt-1.5">
              {ops.reallocations.length > 0 && <Tag tone="accent">Reallocation proposed</Tag>}
              {ops.proposals.length - ops.reallocations.length > 0 && <Tag tone="accent">Approval needed</Tag>}
              {ops.duplicatePending && <Tag tone="warn">Possible duplicate</Tag>}
              {loc.needsVerification && <Tag tone="warn">Verify location</Tag>}
              {esc?.minutes === 0 && <Tag tone="danger">{incident.status === 'triage' ? 'Dispatch overdue' : 'Arrival overdue'}</Tag>}
            </div>
          )}
          {esc && esc.minutes > 0 && esc.minutes <= 20 && (
            <div className="flex items-center gap-1 text-[11px] font-medium mt-1" style={{ color: esc.color }}>
              <AlertTriangle className="w-3 h-3" /> {incident.status === 'triage' ? 'Dispatch due' : 'Arrival due'} in {esc.label.replace(' left', '')}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function Tag({ tone, children }: { tone: 'accent' | 'warn' | 'danger'; children: ReactNode }) {
  const cls = tone === 'accent' ? 'text-blue-300 bg-accent/10 border-accent/30'
    : tone === 'warn' ? 'text-warning bg-warning/10 border-warning/30'
      : 'text-red-300 bg-danger/10 border-danger/30';
  return <span className={cx('text-[10px] font-medium px-1.5 py-0.5 rounded border', cls)}>{children}</span>;
}

function Chip({ active, color, onClick, children }: { active: boolean; color?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx('flex-1 justify-center px-1.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer border inline-flex items-center gap-1',
        active ? 'bg-bg-card-hover text-text border-border-light' : 'text-text-dim border-transparent hover:text-text')}
    >
      {color && <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </button>
  );
}
