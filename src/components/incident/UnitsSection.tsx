import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowRight, CheckCircle, ChevronDown, Hospital, MapPin, Plus, RefreshCw, Route, Truck, UserCog, XCircle, Zap,
} from 'lucide-react';
import { useStore } from '../../store/useStore';
import { fetchRoute, proposeAssignment, recommendResources, updateAssignment } from '../../lib/data';
import { ApiError } from '../../lib/http';
import { ACTIVE_ASSIGNMENT } from '../../lib/operations';
import {
  PROPOSAL_KIND, RESOURCE_TYPE_CONFIG, capabilityLabel, slotPurpose, formatDistance, formatTimeAgo, haversineDistance, routeViaLabel,
} from '../../utils/helpers';
import { Badge, Button, Callout, EmptyState } from '../ui/primitives';
import { cx } from '../../utils/cx';
import { useConfirm } from '../ui/ConfirmDialog';
import type { SlotStatus } from '../../lib/slots';
import type {
  AssignmentStatus, Incident, RecommendResult, Resource, ResourceAssignment, DemandSlot,
} from '../../types';

const STATUS_LABEL: Record<AssignmentStatus, string> = {
  recommended: 'Proposed', dispatched: 'Dispatched', en_route: 'En route', arrived: 'On scene', completed: 'Released', rejected: 'Rejected / cancelled',
};

interface Props {
  incident: Incident;
  assignments: ResourceAssignment[];
  resourcesById: Map<string, Resource>;
  slotStatuses: SlotStatus[];
  canManage: boolean;
  active: boolean;
  onRecommendResult: (r: RecommendResult) => void;
}

/** Units for the selected incident: reallocations first, then proposals, then units already responding. */
export function UnitsSection({ incident, assignments, resourcesById, slotStatuses, canManage, active, onRecommendResult }: Props) {
  const allAssignments = useStore((s) => s.assignments);
  const incidents = useStore((s) => s.incidents);
  const [recommending, setRecommending] = useState(false);
  const [recError, setRecError] = useState<{ routing: boolean; message: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [picking, setPicking] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const { confirm, dialog } = useConfirm();

  const proposals = assignments.filter((a) => a.status === 'recommended');
  const reallocations = proposals.filter((a) => a.allocation && a.allocation.kind !== 'new');
  const plain = proposals.filter((a) => !reallocations.includes(a));
  const responding = assignments.filter((a) => ACTIVE_ASSIGNMENT.includes(a.status))
    .sort((a, b) => ACTIVE_ASSIGNMENT.indexOf(b.status) - ACTIVE_ASSIGNMENT.indexOf(a.status));
  const history = assignments.filter((a) => a.status === 'completed' || a.status === 'rejected');

  const recommend = async () => {
    setRecommending(true);
    setRecError(null);
    setNotice('');
    try {
      const res = await recommendResources(incident.id);
      onRecommendResult(res);
      if (res.recommendations.length === 0) {
        const unmet = res.slots.filter((s) => s.status === 'unmet').length;
        setNotice(unmet ? 'No suitable unit is currently available for the open requirements.' : 'The current response already covers this incident; no changes proposed.');
      }
    } catch (err) {
      const routing = err instanceof ApiError && err.code === 'routing_unavailable';
      setRecError({ routing, message: (err as Error).message });
    } finally {
      setRecommending(false);
    }
  };

  /** Approve/reject/progress an assignment. Keeps the backend's forced-reassignment check behind an explicit confirmation. */
  const change = async (a: ResourceAssignment, status: AssignmentStatus) => {
    setBusyId(a.id);
    setActionError('');
    try {
      await updateAssignment(a.id, status);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'resource_busy') {
        const name = resourcesById.get(a.resource_id)?.name ?? a.resource_name ?? 'This unit';
        const ok = await confirm({
          title: `Reassign ${name}?`,
          body: <>{err.message}. Approving takes it off its current incident, which may then need another unit.</>,
          confirmLabel: 'Reassign anyway',
          tone: 'warning',
        });
        if (ok) {
          try {
            await updateAssignment(a.id, status, { force: true });
          } catch (e) {
            setActionError((e as Error).message);
          }
        }
      } else {
        setActionError((err as Error).message);
      }
    } finally {
      setBusyId(null);
    }
  };

  const cancelUnit = async (a: ResourceAssignment) => {
    const name = resourcesById.get(a.resource_id)?.name ?? a.resource_name ?? 'this unit';
    const ok = await confirm({ title: `Cancel ${name}?`, body: 'The unit is released from this incident. The optimizer may propose a replacement, which will need approval.', confirmLabel: 'Cancel unit', tone: 'danger' });
    if (ok) await change(a, 'rejected');
  };

  return (
    <div className="space-y-3">
      {canManage && active && (
        <div className="flex gap-2">
          <Button variant="primary" size="sm" className="flex-1" busy={recommending} icon={<Zap className="w-3.5 h-3.5" />} onClick={recommend}>
            {recommending ? 'Planning…' : proposals.length ? 'Re-plan' : 'Recommend units'}
          </Button>
          <Button size="sm" icon={<UserCog className="w-3.5 h-3.5" />} onClick={() => setPicking((p) => !p)} aria-expanded={picking}>
            Choose unit…
          </Button>
        </div>
      )}
      {canManage && active && !recError && !notice && proposals.length === 0 && (
        <p className="text-[11px] text-text-dim -mt-1">Recommendations come from the global optimizer, which plans all active incidents together. Nothing is dispatched until you approve it.</p>
      )}
      {recError && (
        <Callout tone="danger" title={recError.routing ? 'Routing service unavailable — allocation recommendations are paused' : 'Could not plan units'}>
          {recError.message}
        </Callout>
      )}
      {notice && <Callout tone="info">{notice}</Callout>}
      {actionError && <Callout tone="danger">{actionError}</Callout>}

      {picking && canManage && active && (
        <ResourcePicker incident={incident} slotStatuses={slotStatuses} assignments={assignments} onClose={() => setPicking(false)} />
      )}

      {reallocations.map((a) => (
        <ReallocationCard
          key={a.id}
          assignment={a}
          incident={incident}
          allAssignments={allAssignments}
          incidents={incidents}
          resourcesById={resourcesById}
          busy={busyId === a.id}
          canManage={canManage && active}
          onApprove={() => change(a, 'dispatched')}
          onKeep={() => change(a, 'rejected')}
        />
      ))}

      {plain.map((a) => (
        <ProposalCard
          key={a.id}
          assignment={a}
          resource={resourcesById.get(a.resource_id)}
          busy={busyId === a.id}
          canManage={canManage && active}
          onApprove={() => change(a, 'dispatched')}
          onReject={() => change(a, 'rejected')}
        />
      ))}

      {responding.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-dim">Responding</div>
          {responding.map((a) => (
            <AssignmentRow
              key={a.id}
              assignment={a}
              resource={resourcesById.get(a.resource_id)}
              busy={busyId === a.id}
              canManage={canManage}
              onChange={(s) => (s === 'rejected' ? cancelUnit(a) : change(a, s))}
            />
          ))}
        </div>
      )}

      {proposals.length === 0 && responding.length === 0 && !picking && (
        <EmptyState icon={<Truck />} title="No units assigned yet" className="py-4">
          {active && canManage ? 'Use “Recommend units” to plan a response.' : undefined}
        </EmptyState>
      )}

      {history.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowHistory((s) => !s)} className="text-[11px] text-text-dim hover:text-text inline-flex items-center gap-1 cursor-pointer">
            <ChevronDown className={cx('w-3.5 h-3.5 transition-transform', showHistory && 'rotate-180')} /> Earlier units ({history.length})
          </button>
          {showHistory && (
            <ul className="mt-1.5 space-y-1">
              {history.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-[11px] text-text-dim px-2 py-1 rounded bg-bg-inset">
                  <span aria-hidden>{a.resource_type ? RESOURCE_TYPE_CONFIG[a.resource_type].icon : '•'}</span>
                  <span className="truncate flex-1">{resourcesById.get(a.resource_id)?.name ?? a.resource_name}</span>
                  <span>{a.coordinator_action === 'reassigned' ? 'Reassigned elsewhere' : STATUS_LABEL[a.status]}</span>
                  <span>{formatTimeAgo(a.updated_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {dialog}
    </div>
  );
}

// ── Explanation helpers: translate allocation metadata into plain facts ─────────

function capabilityFact(slot: DemandSlot | undefined, resource: Resource | undefined) {
  if (!slot) return null;
  const caps = new Set(resource?.capabilities ?? []);
  const required = slot.required_caps;
  const preferred = slot.preferred_caps.filter((c) => caps.has(c));
  const missingPreferred = slot.preferred_caps.filter((c) => !caps.has(c));
  if (!required.length && !slot.preferred_caps.length) return { text: `Standard ${RESOURCE_TYPE_CONFIG[slot.resource_type].label.toLowerCase()}`, ok: true };
  const parts: string[] = [];
  if (required.length) parts.push(required.every((c) => caps.has(c)) ? `Full match: ${required.map(capabilityLabel).join(', ')}` : `Missing ${required.filter((c) => !caps.has(c)).map(capabilityLabel).join(', ')}`);
  if (preferred.length) parts.push(`has preferred ${preferred.map(capabilityLabel).join(', ')}`);
  if (missingPreferred.length) parts.push(`lacks preferred ${missingPreferred.map(capabilityLabel).join(', ')}`);
  const text = parts.join('; ');
  return { text: text.charAt(0).toUpperCase() + text.slice(1), ok: required.every((c) => caps.has(c)) };
}

function capacityFact(slot: DemandSlot | undefined, resource: Resource | undefined) {
  if (!slot || slot.capacity_need <= 0 || !resource) return null;
  const free = Math.max(0, resource.capacity - resource.current_load);
  return { text: `${free} seat${free === 1 ? '' : 's'} free for ${slot.capacity_need} patient${slot.capacity_need > 1 ? 's' : ''}`, ok: free >= slot.capacity_need };
}

function Fact({ label, children, tone }: { label: string; children: ReactNode; tone?: 'ok' | 'warn' }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-text-dim">{label}</div>
      <div className={cx('text-[12px] leading-snug', tone === 'warn' ? 'text-warning' : 'text-text')}>{children}</div>
    </div>
  );
}

function WhyThisUnit({ assignment, resource }: { assignment: ResourceAssignment; resource: Resource | undefined }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const m = assignment.allocation;
  if (!m) {
    const text = assignment.ai_reasoning ?? (assignment.coordinator_notes ? `Manual proposal: ${assignment.coordinator_notes}` : null);
    return text ? <p className="text-[11px] text-text-muted">{text}</p> : <p className="text-[11px] text-text-dim">Manual proposal by a coordinator.</p>;
  }
  const cap = capabilityFact(m.slot, resource);
  const cpy = capacityFact(m.slot, resource);
  const alt = m.alternatives?.[0];
  const summary = `Proposed for the requirement “${slotPurpose(m.slot.purpose).toLowerCase()}”. It ${cap?.ok === false ? 'is the closest feasible option' : 'meets the required capability'}, reaches the incident in about ${m.eta.minutes} min by road, and gave the highest risk-weighted response value among the units the optimizer could use${alt ? `. Next best was ${alt.name}${alt.eta_min != null ? ` (~${Math.round(alt.eta_min)} min)` : ''}` : ''}.`;

  return (
    <div className="border-t border-border pt-2">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-[11px] font-medium text-blue-300 hover:text-blue-200 inline-flex items-center gap-1 cursor-pointer">
        <ChevronDown className={cx('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} /> Why this unit?
      </button>
      {open && (
        <div className="mt-2 space-y-2.5">
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Fact label="ETA">~{m.eta.minutes} min{m.eta.distance_m != null ? ` · ${formatDistance(m.eta.distance_m)}` : ''}</Fact>
            <Fact label="Route">{routeViaLabel(m.eta.route_via)}</Fact>
            {cap && <Fact label="Capability" tone={cap.ok ? 'ok' : 'warn'}>{cap.text}</Fact>}
            {cpy && <Fact label="Capacity" tone={cpy.ok ? 'ok' : 'warn'}>{cpy.text}</Fact>}
            <Fact label="Position">{m.eta.gps_fresh ? 'Live GPS' : 'Last known position'}</Fact>
            <Fact label="Scarcity">{m.utility.scarcity > 0 ? 'Few spare units of this type' : 'Other units of this type free'}</Fact>
          </div>
          <p className="text-[11px] text-text-muted leading-relaxed">{summary}</p>
          {m.destination && (
            <p className="text-[11px] text-text-muted flex items-start gap-1.5">
              <Hospital className="w-3.5 h-3.5 text-success flex-shrink-0 mt-px" />
              Patients to {m.destination.name}{m.destination.eta_min != null ? ` (~${Math.round(m.destination.eta_min)} min)` : ''} · {m.destination.free_beds} beds free after this plan
            </p>
          )}
          {m.degraded && <p className="text-[11px] text-warning">Planned while routing was degraded; verify the route before approving.</p>}
          {assignment.ai_reasoning && (
            <div>
              <button type="button" onClick={() => setRaw((r) => !r)} className="text-[10px] text-text-dim hover:text-text-muted cursor-pointer">{raw ? 'Hide' : 'Show'} optimizer detail</button>
              {raw && <p className="text-[10px] text-text-dim mt-1 leading-relaxed">{assignment.ai_reasoning}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProposalCard({ assignment: a, resource, busy, canManage, onApprove, onReject }: {
  assignment: ResourceAssignment; resource: Resource | undefined; busy: boolean; canManage: boolean; onApprove: () => void; onReject: () => void;
}) {
  const type = resource?.type ?? a.resource_type;
  const cfg = type ? RESOURCE_TYPE_CONFIG[type] : null;
  const eta = a.allocation?.eta.minutes ?? a.eta_minutes;
  // Rows without optimizer metadata are either a coordinator's manual pick or an older recommendation.
  const manual = !a.allocation && !a.ai_reasoning;
  const legacy = !a.allocation && !!a.ai_reasoning;
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/[0.06] p-3 space-y-2.5">
      <div className="flex items-start gap-2.5">
        <span className="text-lg leading-none mt-0.5" aria-hidden>{cfg?.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{resource?.name ?? a.resource_name ?? 'Unknown unit'}</div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-[11px] text-text-dim">{cfg?.label}</span>
            <Badge className={a.allocation ? 'text-blue-300 border-accent/40 bg-accent/10' : 'text-text-muted border-border-light'}>
              {a.allocation ? PROPOSAL_KIND[a.allocation.kind].label : manual ? 'Manual proposal' : 'Earlier recommendation'}
            </Badge>
          </div>
        </div>
        {eta != null && (
          <div className="text-right flex-shrink-0">
            <div className="text-lg font-semibold leading-none tabular-nums">{Math.round(eta)}<span className="text-xs font-normal text-text-dim"> min</span></div>
            <div className="text-[10px] text-text-dim mt-0.5">road ETA</div>
          </div>
        )}
      </div>
      {a.allocation?.destination_warning && <Callout tone="warning">{a.allocation.destination_warning}</Callout>}
      <WhyThisUnit assignment={a} resource={resource} />
      {canManage && (
        <div className="flex gap-2">
          <Button variant="success" size="sm" className="flex-1" busy={busy} icon={<CheckCircle className="w-3.5 h-3.5" />} onClick={onApprove}>
            Approve & dispatch
          </Button>
          <Button variant="danger" size="sm" disabled={busy} icon={<XCircle className="w-3.5 h-3.5" />} onClick={onReject}>Reject</Button>
        </div>
      )}
      {manual && canManage && <p className="text-[10px] text-text-dim">Manual proposals are replaced if you re-run recommendations for this incident.</p>}
      {legacy && canManage && <p className="text-[10px] text-text-dim">Made before the global optimizer was introduced. Use Re-plan for a current plan.</p>}
    </div>
  );
}

function ReallocationCard({ assignment: a, incident, allAssignments, incidents, resourcesById, busy, canManage, onApprove, onKeep }: {
  assignment: ResourceAssignment; incident: Incident; allAssignments: ResourceAssignment[]; incidents: Incident[];
  resourcesById: Map<string, Resource>; busy: boolean; canManage: boolean; onApprove: () => void; onKeep: () => void;
}) {
  const m = a.allocation!;
  const unit = resourcesById.get(a.resource_id);
  const unitName = unit?.name ?? a.resource_name ?? 'Unit';
  const replaced = m.replaces_assignment_id ? allAssignments.find((x) => x.id === m.replaces_assignment_id) : undefined;
  const replacedName = replaced ? resourcesById.get(replaced.resource_id)?.name ?? replaced.resource_name : null;
  const fromIncident = m.move_from_incident_id ? incidents.find((i) => i.id === m.move_from_incident_id) : undefined;
  const backfilled = m.backfill_for_assignment_id ? allAssignments.find((x) => x.id === m.backfill_for_assignment_id) : undefined;
  const backfillMovingTo = backfilled
    ? allAssignments.find((x) => x.status === 'recommended' && x.allocation?.kind === 'move' && x.allocation.replaces_assignment_id === backfilled.id)
    : undefined;
  // For a move, the backfill proposed to cover the incident the unit leaves.
  const coverForSource = m.kind === 'move'
    ? allAssignments.find((x) => x.status === 'recommended' && x.allocation?.kind === 'backfill' && x.allocation.backfill_for_assignment_id === m.replaces_assignment_id)
    : undefined;
  const avoidsBlock = m.eta.route_via === 'alternative' || m.eta.route_via === 'detour';
  const cap = capabilityFact(m.slot, unit);
  const saving = m.kind === 'replacement' && replaced?.eta_minutes != null ? Math.round(replaced.eta_minutes - m.eta.minutes) : null;

  return (
    <div className="rounded-lg border border-warning/50 bg-warning/[0.06] overflow-hidden">
      <div className="px-3 py-2 border-b border-warning/30 flex items-center gap-2">
        <RefreshCw className="w-4 h-4 text-warning" />
        <span className="text-xs font-semibold text-yellow-200">Response change proposed</span>
        <Badge className="ml-auto text-warning border-warning/40">{PROPOSAL_KIND[m.kind].label}</Badge>
      </div>
      <div className="p-3 space-y-3">
        {m.kind === 'backfill' ? (
          <p className="text-xs text-text-muted leading-relaxed">
            <b className="text-text">{unitName}</b> covers this incident if the proposed move of{' '}
            <b className="text-text">{backfilled ? resourcesById.get(backfilled.resource_id)?.name ?? backfilled.resource_name : 'its current unit'}</b>
            {backfillMovingTo ? <> to <b className="text-text">{incidents.find((i) => i.id === backfillMovingTo.incident_id)?.title ?? 'another incident'}</b></> : null} is approved.
          </p>
        ) : (
          <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
            <div className="rounded-md border border-border bg-bg-inset p-2 min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-text-dim">{m.kind === 'move' ? 'Currently at' : 'Current'}</div>
              {m.kind === 'move' ? (
                <>
                  <div className="text-xs font-semibold truncate">{unitName}</div>
                  <div className="text-[11px] text-text-muted truncate">{fromIncident?.title ?? 'Another incident'}</div>
                </>
              ) : (
                <>
                  <div className="text-xs font-semibold truncate">{replacedName ?? 'Previous unit'}</div>
                  <div className="text-[11px] text-text-muted">
                    {replaced ? STATUS_LABEL[replaced.status] : 'No longer feasible'}
                    {replaced?.eta_minutes != null && <> · last ETA {Math.round(replaced.eta_minutes)} min</>}
                  </div>
                </>
              )}
            </div>
            <ArrowRight className="w-4 h-4 text-text-dim self-center" />
            <div className="rounded-md border border-success/40 bg-success/[0.06] p-2 min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-success">Proposed here</div>
              <div className="text-xs font-semibold truncate">{unitName}</div>
              <div className="text-[11px] text-text-muted">ETA ~{Math.round(m.eta.minutes)} min{saving != null && saving > 0 ? ` · ${saving} min sooner` : ''}</div>
            </div>
          </div>
        )}

        <div>
          <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1">Why</div>
          <ul className="space-y-0.5 text-[11px] text-text-muted">
            {m.kind === 'replacement' && <li>• The current assignment for this requirement is no longer feasible in the latest plan{avoidsBlock ? ' (road blocked on its route)' : ''}.</li>}
            {m.kind === 'move' && <li>• This incident ({incident.priority}) gains more from the unit than its current incident, after the reassignment cost.</li>}
            {avoidsBlock && <li>• {routeViaLabel(m.eta.route_via)}</li>}
            {cap && <li>• {cap.text}</li>}
            <li>• {m.eta.gps_fresh ? 'ETA from live GPS' : 'ETA from last known position'}</li>
          </ul>
        </div>

        {m.kind === 'move' && (
          <p className="text-[11px] text-warning">
            Impact: {fromIncident?.title ?? 'The other incident'} loses this unit.{' '}
            {coverForSource ? <>Backfill proposed: <b>{resourcesById.get(coverForSource.resource_id)?.name ?? coverForSource.resource_name}</b>.</> : 'No backfill unit is currently available.'}
          </p>
        )}

        {canManage && (
          <div className="flex flex-col sm:flex-row gap-2">
            <Button variant="primary" size="sm" className="flex-1" busy={busy} onClick={onApprove}>
              Approve {m.kind === 'backfill' ? 'backfill' : 'reallocation'}
            </Button>
            <Button size="sm" disabled={busy} onClick={onKeep}>{m.kind === 'backfill' ? 'Decline' : 'Keep current'}</Button>
          </div>
        )}
        <p className="text-[10px] text-text-dim">Nothing changes until you approve. Approving uses the normal dispatch checks.</p>
      </div>
    </div>
  );
}

function AssignmentRow({ assignment: a, resource, busy, canManage, onChange }: {
  assignment: ResourceAssignment; resource: Resource | undefined; busy: boolean; canManage: boolean; onChange: (s: AssignmentStatus) => void;
}) {
  const type = resource?.type ?? a.resource_type;
  const cfg = type ? RESOURCE_TYPE_CONFIG[type] : null;
  const live = !!(resource?.location_updated_at && Date.now() - new Date(resource.location_updated_at).getTime() < 5 * 60_000);
  return (
    <div className="rounded-lg border border-border bg-bg-inset p-2.5">
      <div className="flex items-center gap-2.5">
        <span aria-hidden>{cfg?.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold truncate">{resource?.name ?? a.resource_name}</div>
          <div className="text-[11px] text-text-dim flex gap-2 flex-wrap">
            <span className={a.status === 'arrived' ? 'text-success' : 'text-sky-300'}>{STATUS_LABEL[a.status]}</span>
            {a.eta_minutes != null && a.status !== 'arrived' && <span>ETA ~{a.eta_minutes} min (at dispatch)</span>}
            {live && <span className="text-success">Live GPS</span>}
          </div>
        </div>
      </div>
      {canManage && (
        <div className="flex gap-1.5 mt-2 flex-wrap">
          {a.status === 'dispatched' && <Button size="sm" busy={busy} icon={<Route className="w-3.5 h-3.5" />} onClick={() => onChange('en_route')}>En route</Button>}
          {(a.status === 'dispatched' || a.status === 'en_route') && <Button size="sm" disabled={busy} icon={<MapPin className="w-3.5 h-3.5" />} onClick={() => onChange('arrived')}>Arrived</Button>}
          {a.status === 'arrived' && <Button size="sm" variant="success" busy={busy} icon={<CheckCircle className="w-3.5 h-3.5" />} onClick={() => onChange('completed')}>Complete & release</Button>}
          {(a.status === 'dispatched' || a.status === 'en_route') && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onChange('rejected')}>Cancel</Button>}
        </div>
      )}
    </div>
  );
}

// ── Manual override: choose a specific unit ─────────────────────────────────────

const MOBILE = ['ambulance', 'fire_truck', 'police', 'road_crew'];

/**
 * Lists available units that can fill one of the incident's requirements (right type and required capabilities).
 * Creates an ordinary proposal through the assignment API; approval and all backend checks still apply.
 */
function ResourcePicker({ incident, slotStatuses, assignments, onClose }: {
  incident: Incident; slotStatuses: SlotStatus[]; assignments: ResourceAssignment[]; onClose: () => void;
}) {
  const resources = useStore((s) => s.resources);
  const allAssignments = useStore((s) => s.assignments);
  const incidents = useStore((s) => s.incidents);
  const [etas, setEtas] = useState<Record<string, number | 'none'>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const openSlots = slotStatuses.filter((s) => s.state === 'open' || s.state === 'unavailable').map((s) => s.slot);
  const slots = openSlots.length ? openSlots : slotStatuses.map((s) => s.slot);

  const candidates = useMemo(() => {
    const taken = new Set(assignments.filter((a) => a.status === 'recommended' || ACTIVE_ASSIGNMENT.includes(a.status)).map((a) => a.resource_id));
    const fits = (r: Resource) => slots.some((s) => s.resource_type === r.type && s.required_caps.every((c) => r.capabilities.includes(c)));
    return resources
      .filter((r) => MOBILE.includes(r.type) && r.status === 'available' && !taken.has(r.id) && r.location_lat != null && r.location_lng != null && fits(r))
      .map((r) => ({ r, km: incident.location_lat != null && incident.location_lng != null ? haversineDistance(r.location_lat!, r.location_lng!, incident.location_lat, incident.location_lng) : Infinity }))
      // Straight-line distance only orders the list; the ETA shown is the road route.
      .sort((a, b) => a.km - b.km)
      .slice(0, 8)
      .map((x) => x.r);
  }, [resources, assignments, slots, incident.location_lat, incident.location_lng]);

  useEffect(() => {
    if (incident.location_lat == null || incident.location_lng == null) return;
    let cancelled = false;
    for (const r of candidates) {
      fetchRoute([r.location_lat!, r.location_lng!], [incident.location_lat, incident.location_lng])
        .then((route) => { if (!cancelled) setEtas((e) => ({ ...e, [r.id]: Math.max(1, Math.round(route.duration_s / 60)) })); })
        .catch(() => { if (!cancelled) setEtas((e) => ({ ...e, [r.id]: 'none' })); });
    }
    return () => { cancelled = true; };
  }, [candidates, incident.location_lat, incident.location_lng]);

  const propose = async (r: Resource) => {
    setBusyId(r.id);
    setError('');
    try {
      await proposeAssignment(incident.id, r.id, 'Chosen manually by coordinator');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-lg border border-border-light bg-bg-inset p-3 space-y-2">
      <div className="flex items-center gap-2">
        <UserCog className="w-4 h-4 text-text-dim" />
        <span className="text-xs font-semibold">Choose a unit manually</span>
        <button type="button" onClick={onClose} className="ml-auto text-[11px] text-text-dim hover:text-text cursor-pointer">Close</button>
      </div>
      <p className="text-[11px] text-text-dim">
        Available units that meet {openSlots.length ? 'an open' : 'a'} requirement, nearest first. Choosing one creates a proposal; it still needs approval and the usual checks.
      </p>
      {/* Once road ETAs arrive, the list re-sorts by them; units without a route go last. */}
      {candidates.length === 0 ? (
        <p className="text-xs text-text-muted py-2">No suitable unit is currently available.</p>
      ) : (
        <ul className="space-y-1">
          {[...candidates].sort((a, b) => etaRank(etas[a.id]) - etaRank(etas[b.id])).map((r) => {
            const eta = etas[r.id];
            const elsewhere = allAssignments.find((a) => a.resource_id === r.id && a.status === 'recommended' && a.incident_id !== incident.id);
            const elsewhereTitle = elsewhere ? incidents.find((i) => i.id === elsewhere.incident_id)?.title ?? elsewhere.incident_title : null;
            return (
              <li key={r.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-bg-card-hover">
                <span aria-hidden>{RESOURCE_TYPE_CONFIG[r.type].icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{r.name}</div>
                  <div className="text-[10px] text-text-dim truncate">
                    {eta === undefined ? 'Checking road route…' : eta === 'none' ? 'No road route available' : `~${eta} min by road`}
                    {r.capabilities.length ? ` · ${r.capabilities.map(capabilityLabel).join(', ')}` : ''}
                  </div>
                  {elsewhere && <div className="text-[10px] text-warning truncate">Already proposed for {elsewhereTitle ?? 'another incident'}</div>}
                </div>
                <Button size="sm" busy={busyId === r.id} disabled={eta === 'none' || (busyId !== null && busyId !== r.id)} icon={<Plus className="w-3.5 h-3.5" />} onClick={() => propose(r)}>
                  Propose
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}

function etaRank(eta: number | 'none' | undefined) {
  return typeof eta === 'number' ? eta : eta === 'none' ? 1e9 : 1e8;
}
