/**
 * Hard feasibility rules for resource ↔ demand-slot pairs. A pair that fails any rule is not an
 * edge in the assignment problem at all (never merely a low score). Route feasibility (road route
 * exists, avoids blocked roads, within the response window) is checked by the optimizer with the
 * routing service.
 */
import { MOBILE_RESOURCE_TYPES, type DemandSlot } from './demand.js';

export interface AllocResource {
  id: string;
  type: string;
  name: string;
  status: string;
  location_lat: number | null;
  location_lng: number | null;
  location_updated_at: string | Date | null;
  capacity: number;
  current_load: number;
  capabilities: string[] | null;
  assigned_incident_id: string | null;
}

/** A resource's current active assignment (dispatched / en_route / arrived). */
export interface Commitment {
  assignment_id: string;
  resource_id: string;
  incident_id: string;
  status: 'dispatched' | 'en_route' | 'arrived';
  eta_minutes: number | null;
  updated_at: string | Date;
}

export type Feasibility = { ok: true } | { ok: false; reason: string };

export const isMobile = (r: AllocResource) => (MOBILE_RESOURCE_TYPES as readonly string[]).includes(r.type);
export const freeCapacity = (r: AllocResource) => Math.max(0, (r.capacity ?? 0) - (r.current_load ?? 0));
export const pairKey = (resourceId: string, incidentId: string) => `${resourceId}|${incidentId}`;

/**
 * Structural feasibility (everything except routing).
 * `commitment` is the resource's current active assignment, if any.
 */
export function structuralFeasibility(
  r: AllocResource,
  slot: DemandSlot,
  ctx: { rejectedPairs: Set<string>; commitment?: Commitment; allowMoves: boolean },
): Feasibility {
  if (!isMobile(r)) return { ok: false, reason: `${r.type} is a destination facility, not a dispatchable unit` };
  if (r.type !== slot.resource_type) return { ok: false, reason: `${r.type} cannot fill a ${slot.resource_type} slot` };
  if (r.status === 'unavailable') return { ok: false, reason: 'resource unavailable' };
  const caps = Array.isArray(r.capabilities) ? r.capabilities : [];
  const missing = slot.required_caps.filter((c) => !caps.includes(c));
  if (missing.length) return { ok: false, reason: `missing required capability: ${missing.join(', ')}` };
  if (slot.capacity_need > 0 && freeCapacity(r) < slot.capacity_need) {
    return { ok: false, reason: `insufficient free capacity (${freeCapacity(r)} of ${slot.capacity_need} seats needed)` };
  }
  if (r.location_lat == null || r.location_lng == null) return { ok: false, reason: 'no known position' };

  const c = ctx.commitment;
  if (c && c.incident_id !== slot.incident_id) {
    if (c.status === 'arrived') return { ok: false, reason: 'on scene at another incident (locked)' };
    if (!ctx.allowMoves) return { ok: false, reason: `committed to another incident (${c.status})` };
  }
  if (!c || c.incident_id !== slot.incident_id) {
    if (ctx.rejectedPairs.has(pairKey(r.id, slot.incident_id))) return { ok: false, reason: 'recently rejected by coordinator (cooldown)' };
  }
  return { ok: true };
}
