import { useMemo } from 'react';
import { useStore, isActiveStatus } from '../store/useStore';
import { compareOperational, locationQuality } from '../utils/helpers';
import type { AssignmentStatus, Incident, ResourceAssignment } from '../types';

/** Operational state derived from the live store. Everything here is computed from real rows; nothing is estimated. */

export const ACTIVE_ASSIGNMENT: AssignmentStatus[] = ['dispatched', 'en_route', 'arrived'];

export interface IncidentOps {
  /** Units dispatched, en route or on scene. */
  active: ResourceAssignment[];
  /** Proposals waiting for coordinator approval. */
  proposals: ResourceAssignment[];
  /** Proposals that move, replace or backfill a unit (dynamic reallocation). */
  reallocations: ResourceAssignment[];
  /** Soonest ETA among units still travelling. */
  nextEtaMin: number | null;
  locationCheck: boolean;
  duplicatePending: boolean;
  overdue: boolean;
}

export function opsFor(incident: Incident, assignments: ResourceAssignment[], now = Date.now()): IncidentOps {
  const mine = assignments.filter((a) => a.incident_id === incident.id);
  const active = mine.filter((a) => ACTIVE_ASSIGNMENT.includes(a.status));
  const proposals = mine.filter((a) => a.status === 'recommended');
  const travelling = active.filter((a) => (a.status === 'dispatched' || a.status === 'en_route') && a.eta_minutes != null);
  return {
    active,
    proposals,
    reallocations: proposals.filter((a) => a.allocation && a.allocation.kind !== 'new'),
    nextEtaMin: travelling.length ? Math.min(...travelling.map((a) => a.eta_minutes!)) : null,
    locationCheck: locationQuality(incident).needsVerification,
    duplicatePending: incident.dedup_review?.status === 'pending',
    overdue: (incident.status === 'triage' || incident.status === 'dispatched')
      && !!incident.escalation_deadline && new Date(incident.escalation_deadline).getTime() <= now,
  };
}

export function useActiveIncidents() {
  const incidents = useStore((s) => s.incidents);
  return useMemo(
    () => incidents.filter((i) => isActiveStatus(i.status) && !i.parent_incident_id).sort(compareOperational),
    [incidents],
  );
}

export function useIncidentOps() {
  const active = useActiveIncidents();
  const assignments = useStore((s) => s.assignments);
  return useMemo(() => new Map(active.map((i) => [i.id, opsFor(i, assignments)])), [active, assignments]);
}

export type ActionKind = 'reallocation' | 'approval' | 'location' | 'duplicate' | 'overdue';

export interface ActionItem {
  key: string;
  kind: ActionKind;
  incident: Incident;
  label: string;
}

/** Items that need a coordinator decision, most urgent incident first. */
export function actionItems(incidents: Incident[], ops: Map<string, IncidentOps>): ActionItem[] {
  const items: ActionItem[] = [];
  for (const incident of incidents) {
    const o = ops.get(incident.id);
    if (!o) continue;
    if (o.reallocations.length) {
      items.push({ key: `${incident.id}:realloc`, kind: 'reallocation', incident, label: o.reallocations.length === 1 ? 'Reallocation proposed' : `${o.reallocations.length} reallocation proposals` });
    }
    const plain = o.proposals.length - o.reallocations.length;
    if (plain > 0) {
      items.push({ key: `${incident.id}:approve`, kind: 'approval', incident, label: `${plain} unit${plain > 1 ? 's' : ''} awaiting approval` });
    }
    if (o.duplicatePending) items.push({ key: `${incident.id}:dup`, kind: 'duplicate', incident, label: 'Possible duplicate — review' });
    if (o.locationCheck) items.push({ key: `${incident.id}:loc`, kind: 'location', incident, label: 'Location needs verification' });
    if (o.overdue) items.push({ key: `${incident.id}:overdue`, kind: 'overdue', incident, label: incident.status === 'triage' ? 'Dispatch overdue' : 'Arrival overdue' });
  }
  return items;
}
