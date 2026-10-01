import { ACTIVE_ASSIGNMENT } from './operations';
import type { DemandSlot, IncidentDemand, RecommendResult, Resource, ResourceAssignment } from '../types';

export type SlotState = 'covered' | 'proposed' | 'open' | 'unavailable';

export interface SlotStatus {
  slot: DemandSlot;
  state: SlotState;
  assignment?: ResourceAssignment;
  reason?: string | null;
}

/**
 * Matches the incident's demand slots with its current assignments: optimizer rows by their slot id first,
 * then manual/legacy rows by unit type. "Unavailable" comes only from the optimizer's own last run.
 */
export function matchSlots(
  demand: IncidentDemand,
  assignments: ResourceAssignment[],
  resourcesById: Map<string, Resource>,
  outcomes: RecommendResult['slots'] | null,
) {
  const live = assignments.filter((a) => a.status === 'recommended' || ACTIVE_ASSIGNMENT.includes(a.status));
  const used = new Set<string>();
  const typeOf = (a: ResourceAssignment) => a.resource_type ?? resourcesById.get(a.resource_id)?.type;
  const rank = (a: ResourceAssignment) => (a.status === 'recommended' ? 1 : 0);

  const matched = new Map<string, ResourceAssignment>();
  for (const slot of demand.slots) {
    const a = live.find((x) => !used.has(x.id) && x.allocation?.slot?.id === slot.id);
    if (a) { matched.set(slot.id, a); used.add(a.id); }
  }
  for (const slot of demand.slots) {
    if (matched.has(slot.id)) continue;
    const a = live.filter((x) => !used.has(x.id) && typeOf(x) === slot.resource_type).sort((x, y) => rank(x) - rank(y))[0];
    if (a) { matched.set(slot.id, a); used.add(a.id); }
  }

  const statuses: SlotStatus[] = demand.slots.map((slot) => {
    const a = matched.get(slot.id);
    if (a) return { slot, state: a.status === 'recommended' ? 'proposed' : 'covered', assignment: a };
    const outcome = outcomes?.find((o) => o.slot === slot.id);
    if (outcome?.status === 'unmet') return { slot, state: 'unavailable', reason: outcome.reason };
    return { slot, state: 'open' };
  });
  return { statuses, extra: live.filter((a) => !used.has(a.id)) };
}
