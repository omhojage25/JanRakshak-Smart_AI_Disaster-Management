/**
 * Utility of assigning a feasible resource r to demand slot s of incident i:
 *
 *   U(r,s) = R_i · π_s · ( wT · T(ETA) + wF · F(r,s) )  −  wS · O(type)
 *
 *   R_i  risk weight       = (priority_score_i / 100) ^ gamma          (ML-derived priority)
 *   π_s  slot importance   (demand model: first essential unit 1, later units decay)
 *   T    time value       = 1 if ETA ≤ target(priority), else exp(−(ETA − target)/(target·decay))
 *   F    fit              = capability fit (preferred capabilities), × capacity fit for transport slots
 *   O    scarcity         = 1 − available/demanded for that unit type, clipped to [0,1]
 *
 * The optimizer maximizes Σ x(r,s)·(U(r,s) − M(r,s)) where M is the reassignment cost (for a move:
 * reassignment cost + the minimum-improvement threshold, so every individual move must pay for itself).
 */
import type { Priority } from '../../constants.js';
import { ALLOCATION_CONFIG as C } from './config.js';
import { freeCapacity, type AllocResource, type Commitment } from './candidates.js';
import type { DemandSlot } from './demand.js';

export const riskWeight = (priorityScore: number) =>
  Math.min(1, Math.max(0, priorityScore / 100)) ** C.riskGamma;

export function etaValue(etaMin: number, priority: string): number {
  const target = C.responseTargetMin[(priority as Priority)] ?? C.responseTargetMin.medium;
  if (etaMin <= target) return 1;
  return Math.exp(-(etaMin - target) / (target * C.etaDecayFactor));
}

export function capabilityFit(r: AllocResource, slot: DemandSlot): number {
  if (!slot.preferred_caps.length) return 1;
  const caps = Array.isArray(r.capabilities) ? r.capabilities : [];
  const have = slot.preferred_caps.filter((c) => caps.includes(c)).length;
  return (1 + have) / (1 + slot.preferred_caps.length);
}

/** Capacity already passed as a hard constraint; this prefers units whose free seats fit the need. */
export function capacityFit(r: AllocResource, slot: DemandSlot): number {
  if (slot.capacity_need <= 0) return 1;
  const free = freeCapacity(r);
  return free <= 0 ? 0 : 0.5 + 0.5 * Math.min(1, slot.capacity_need / free);
}

/** Scarcity per unit type: how far open demand exceeds available units (0 = plenty, → 1 = very scarce). */
export function scarcityByType(openSlots: DemandSlot[], availableResources: AllocResource[]): Record<string, number> {
  const demand: Record<string, number> = {};
  const supply: Record<string, number> = {};
  for (const s of openSlots) demand[s.resource_type] = (demand[s.resource_type] ?? 0) + 1;
  for (const r of availableResources) supply[r.type] = (supply[r.type] ?? 0) + 1;
  const out: Record<string, number> = {};
  for (const t of Object.keys(demand)) out[t] = Math.min(1, Math.max(0, 1 - (supply[t] ?? 0) / demand[t]));
  return out;
}

/**
 * Cost of moving a committed unit away from its current incident.
 * progress: 0 = just dispatched, 1 = about to arrive (from live road ETA vs planned ETA).
 */
export function reassignmentCost(c: Commitment | undefined, targetIncidentId: string, progress: number): number {
  if (!c || c.incident_id === targetIncidentId) return 0;
  if (c.status === 'arrived') return Number.POSITIVE_INFINITY; // locked; also excluded as infeasible
  if (c.status === 'dispatched') return C.reassignCostDispatched;
  return C.reassignCostEnRouteBase + C.reassignCostEnRouteProgress * Math.min(1, Math.max(0, progress));
}

export interface UtilityBreakdown {
  risk_weight: number;
  slot_importance: number;
  eta_min: number;
  eta_value: number;
  capability_fit: number;
  capacity_fit: number;
  fit: number;
  scarcity: number;
  reassignment_cost: number;
  utility: number;
  net: number;
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function computeUtility(
  args: { priority: string; priorityScore: number; slot: DemandSlot; resource: AllocResource; etaMin: number; scarcity: number; moveCost: number },
): UtilityBreakdown {
  const R = riskWeight(args.priorityScore);
  const T = etaValue(args.etaMin, args.priority);
  const capFit = capabilityFit(args.resource, args.slot);
  const cpFit = capacityFit(args.resource, args.slot);
  const F = capFit * cpFit;
  const U = R * args.slot.importance * (C.weightTime * T + C.weightFit * F) - C.weightScarcity * args.scarcity;
  return {
    risk_weight: r4(R), slot_importance: args.slot.importance, eta_min: Math.round(args.etaMin * 10) / 10,
    eta_value: r4(T), capability_fit: r4(capFit), capacity_fit: r4(cpFit), fit: r4(F), scarcity: r4(args.scarcity),
    reassignment_cost: r4(args.moveCost), utility: r4(U), net: r4(U - args.moveCost),
  };
}
