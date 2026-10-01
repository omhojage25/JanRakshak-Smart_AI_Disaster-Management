/**
 * Risk-aware, road-network-based, constrained GLOBAL resource allocation.
 *
 * All active incidents are expanded into demand slots; all dispatchable units are supply;
 * feasible (unit, slot) pairs are edges weighted by utility minus reassignment cost. The
 * assignment is solved exactly (Hungarian, see hungarian.ts) over every incident at once.
 *
 * Road ETA comes from the routing service (travel-time matrix). Every pair the solver selects is
 * then verified against active blocked roads (route geometry); pairs that cannot avoid a blocked
 * road become infeasible and the problem is re-solved, until every selected pair is verified.
 *
 * Moves of already-committed units are only proposed if the best plan WITH moves beats the best
 * plan WITHOUT moves by at least ALLOCATION_CONFIG.minImprovementForMoves.
 *
 * This module is pure with respect to the database: it returns a Plan. Persistence (existing
 * resource_assignments 'recommended' rows) happens in allocationRun.ts.
 */
import { ACTIVE_INCIDENT_STATUSES } from '../../constants.js';
import {
  RoutingUnavailableError, blockedRoadsVersion, getRoutingProvider, travelMatrix, verifiedRoute,
  type BlockedRoadLike, type LatLng,
} from '../routing.js';
import { ALLOCATION_CONFIG as C } from './config.js';
import { DEMAND_EVIDENCE_POLICY, buildIncidentDemand, type DemandSlot, type IncidentDemand } from './demand.js';
import {
  freeCapacity, isMobile, pairKey, structuralFeasibility, type AllocResource, type Commitment,
} from './candidates.js';
import { computeUtility, reassignmentCost, scarcityByType, type UtilityBreakdown } from './utility.js';
import { maxWeightAssignment } from './hungarian.js';

export interface AllocIncident {
  id: string;
  type: string;
  status: string;
  priority: string;
  priority_score: number;
  title?: string | null;
  location_lat: number | null;
  location_lng: number | null;
  parent_incident_id?: string | null;
  people_affected?: number;
  injuries?: number;
  has_children?: boolean;
  has_elderly?: boolean;
  has_disabled?: boolean;
  risk_assessment?: unknown;
}

export interface PlanInput {
  runId: string;
  trigger: string;
  allowMoves: boolean;
  now: Date;
  incidents: AllocIncident[];
  /** All resources, including hospitals and shelters (used only as destinations). */
  resources: AllocResource[];
  /** Active assignments (dispatched / en_route / arrived). */
  commitments: Commitment[];
  /** Coordinator rejections still inside the cooldown window. */
  rejections: { resource_id: string; incident_id: string }[];
  blockedRoads: BlockedRoadLike[];
}

export interface Alternative {
  resource_id: string;
  name: string;
  net?: number;
  eta_min?: number;
  reason?: string;
}

export interface Proposal {
  key: string;
  incident_id: string;
  resource_id: string;
  resource_name: string;
  slot: DemandSlot;
  kind: 'new' | 'move' | 'replacement' | 'backfill';
  replaces_assignment_id: string | null;
  move_from_incident_id: string | null;
  backfill_for_assignment_id: string | null;
  eta_min: number;
  distance_m: number | null;
  route_via: string;
  gps_fresh: boolean;
  utility: UtilityBreakdown;
  incident_priority: string;
  incident_priority_score: number;
  destination: { type: 'hospital'; id: string; name: string; eta_min: number | null; free_beds: number } | null;
  destination_warning: string | null;
  alternatives: Alternative[];
}

export interface SlotOutcome {
  slot: DemandSlot;
  status: 'kept' | 'proposed' | 'unmet';
  resource_id?: string;
  assignment_id?: string;
  reason?: string;
}

export interface Plan {
  run_id: string;
  trigger: string;
  degraded: boolean;
  degraded_reason: string | null;
  routing_backend: string | null;
  blocked_version: string;
  mode: 'no_moves' | 'with_moves';
  objective: number;
  objective_no_moves: number;
  objective_with_moves: number | null;
  proposals: Proposal[];
  slots: SlotOutcome[];
  infeasible_commitments: { assignment_id: string; resource_id: string; incident_id: string; reason: string }[];
  shelters: { incident_id: string; need: number; shelter_id: string | null; name: string | null; free: number; warning: string | null }[];
  warnings: string[];
  stats: {
    incidents: number; slots: number; open_slots: number; resources_considered: number; proposals: number; moves: number;
    unmet_essential: number; verify_iterations: number; route_checks: number; solve_ms: number; total_ms: number;
  };
}

type PairRoute = { status: 'ok'; eta_s: number; distance_m: number | null; via: string } | { status: 'infeasible'; reason: string };

interface Edge {
  net: number;
  breakdown: UtilityBreakdown;
  route: PairRoute & { status: 'ok' };
  verified: boolean;
  moveCost: number;
}

const ACTIVE = new Set<string>(ACTIVE_INCIDENT_STATUSES);
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

function emptyPlan(input: PlanInput, version: string, t0: number, degradedReason: string | null, slots: SlotOutcome[] = []): Plan {
  return {
    run_id: input.runId, trigger: input.trigger, degraded: !!degradedReason, degraded_reason: degradedReason,
    routing_backend: getRoutingProvider()?.id ?? null, blocked_version: version, mode: 'no_moves',
    objective: 0, objective_no_moves: 0, objective_with_moves: null, proposals: [], slots, infeasible_commitments: [],
    shelters: [], warnings: [],
    stats: {
      incidents: 0, slots: slots.length, open_slots: 0, resources_considered: 0, proposals: 0, moves: 0,
      unmet_essential: slots.filter((s) => s.slot.essential && s.status === 'unmet').length,
      verify_iterations: 0, route_checks: 0, solve_ms: 0, total_ms: Math.round(performance.now() - t0),
    },
  };
}

export async function planAllocation(input: PlanInput): Promise<Plan> {
  const t0 = performance.now();
  const version = blockedRoadsVersion(input.blockedRoads);
  const warnings: string[] = [];

  // ── Demand ──
  const incidents = input.incidents.filter((i) => ACTIVE.has(i.status) && !i.parent_incident_id);
  const incById = new Map(incidents.map((i) => [i.id, i]));
  const demands: IncidentDemand[] = incidents.map((i) => buildIncidentDemand(i));
  const resById = new Map(input.resources.map((r) => [r.id, r]));

  // ── Existing commitments fill (pin) matching slots first ──
  const commitByResource = new Map<string, Commitment>();
  for (const c of input.commitments) if (incById.has(c.incident_id)) commitByResource.set(c.resource_id, c);
  const pinnedBy = new Map<string, Commitment>(); // slot id → commitment
  const slotOfAssignment = new Map<string, DemandSlot>();
  const allSlots: DemandSlot[] = [];
  for (const d of demands) {
    const incident = incById.get(d.incident_id)!;
    const onIncident = input.commitments
      .filter((c) => c.incident_id === d.incident_id)
      .sort((a, b) => Number(b.status === 'arrived') - Number(a.status === 'arrived'));
    for (const c of onIncident) {
      const r = resById.get(c.resource_id);
      if (!r) continue;
      const caps = r.capabilities ?? [];
      const free = d.slots.filter((s) => s.resource_type === r.type && !pinnedBy.has(s.id));
      const slot = free.find((s) => s.required_caps.every((cap) => caps.includes(cap))) ?? free[0];
      if (slot) { pinnedBy.set(slot.id, c); slotOfAssignment.set(c.assignment_id, slot); }
    }
    // A contained incident gets no new units; it keeps what it has.
    for (const s of d.slots) if (incident.status !== 'contained' || pinnedBy.has(s.id)) allSlots.push(s);
  }

  const outcomes = new Map<string, SlotOutcome>();
  const unmet = (s: DemandSlot, reason: string) => outcomes.set(s.id, { slot: s, status: 'unmet', reason });

  // ── Supply ──
  const mobile = input.resources.filter(isMobile);
  const free: AllocResource[] = [];
  const movable: AllocResource[] = [];
  for (const r of mobile) {
    if (r.status === 'unavailable' || r.location_lat == null || r.location_lng == null) continue;
    const c = commitByResource.get(r.id);
    if (!c) {
      if (r.status === 'available') free.push(r);
      else warnings.push(`${r.name} is ${r.status} without an active assignment; not considered`);
    } else if (c.status !== 'arrived') {
      movable.push(r);
    }
  }
  const candidates = [...free, ...movable];

  // Commitments that are no longer feasible (unit unavailable) free their slot for a replacement.
  const infeasibleCommitments: Plan['infeasible_commitments'] = [];
  const replacesBySlot = new Map<string, string>();
  const markInfeasible = (c: Commitment, reason: string) => {
    infeasibleCommitments.push({ assignment_id: c.assignment_id, resource_id: c.resource_id, incident_id: c.incident_id, reason });
    const slot = slotOfAssignment.get(c.assignment_id);
    if (slot) { pinnedBy.delete(slot.id); replacesBySlot.set(slot.id, c.assignment_id); }
  };
  for (const c of input.commitments) {
    if (!incById.has(c.incident_id)) continue;
    const r = resById.get(c.resource_id);
    if (!r || r.status === 'unavailable') markInfeasible(c, 'unit became unavailable');
  }

  // ── Road routing: one travel-time matrix for every candidate → every incident ──
  const pos = (x: { location_lat: number | null; location_lng: number | null }): LatLng => ({ lat: x.location_lat!, lng: x.location_lng! });
  const routedIncidents = incidents.filter((i) => i.location_lat != null && i.location_lng != null);
  const incIndex = new Map(routedIncidents.map((i, k) => [i.id, k]));
  const hospitals = input.resources.filter((r) => r.type === 'hospital' && r.location_lat != null && r.location_lng != null && r.status !== 'unavailable');
  const shelters = input.resources.filter((r) => r.type === 'shelter' && r.location_lat != null && r.location_lng != null && r.status !== 'unavailable');
  let matrix: Awaited<ReturnType<typeof travelMatrix>>;
  let facilityMatrix: Awaited<ReturnType<typeof travelMatrix>>;
  let routeChecks = 0;
  const pairRoutes = new Map<string, PairRoute>(); // verified routes, key = resource|incident
  try {
    matrix = await travelMatrix(candidates.map(pos), routedIncidents.map(pos));
    facilityMatrix = await travelMatrix(routedIncidents.map(pos), [...hospitals, ...shelters].map(pos));

    // Re-check the road for every committed unit still travelling (blocked road → infeasible).
    for (const r of movable) {
      const c = commitByResource.get(r.id)!;
      const inc = incById.get(c.incident_id)!;
      if (inc.location_lat == null) continue;
      routeChecks++;
      const v = await verifiedRoute(pos(r), pos(inc), input.blockedRoads);
      if (v.status === 'ok') {
        pairRoutes.set(pairKey(r.id, inc.id), { status: 'ok', eta_s: v.route.duration_s, distance_m: v.route.distance_m, via: v.via });
      } else {
        const reason = v.status === 'blocked' ? 'route to incident now blocked' : 'no road route to incident';
        pairRoutes.set(pairKey(r.id, inc.id), { status: 'infeasible', reason });
        markInfeasible(c, reason);
      }
    }
  } catch (err) {
    if (!(err instanceof RoutingUnavailableError)) throw err;
    const slots = allSlots.map((s) => ({ slot: s, status: pinnedBy.has(s.id) ? 'kept' as const : 'unmet' as const, reason: pinnedBy.has(s.id) ? undefined : 'road routing unavailable' }));
    return emptyPlan(input, version, t0, `Road routing unavailable: ${err.message}`, slots);
  }

  // Re-pin with road ETAs known: within an incident and unit type, the fastest committed unit holds
  // the most important slot it can fill. (Pinning order must not make the status quo look worse
  // than it is, or the optimizer would propose pointless slot swaps.)
  const commitEta = (c: Commitment) => {
    if (c.status === 'arrived') return 0;
    const pr = pairRoutes.get(pairKey(c.resource_id, c.incident_id));
    return pr?.status === 'ok' ? pr.eta_s : Number.POSITIVE_INFINITY;
  };
  for (const d of demands) {
    for (const type of new Set(d.slots.map((s) => s.resource_type))) {
      const slotsT = d.slots.filter((s) => s.resource_type === type && pinnedBy.has(s.id));
      if (slotsT.length < 2) continue;
      const pool = slotsT.map((s) => pinnedBy.get(s.id)!).sort((a, b) => commitEta(a) - commitEta(b));
      for (const s of slotsT) pinnedBy.delete(s.id);
      for (const s of [...slotsT].sort((a, b) => b.importance - a.importance)) {
        const caps = (c: Commitment) => resById.get(c.resource_id)?.capabilities ?? [];
        const k = pool.findIndex((c) => s.required_caps.every((cap) => caps(c).includes(cap)));
        const [c] = pool.splice(k >= 0 ? k : 0, 1);
        pinnedBy.set(s.id, c);
        slotOfAssignment.set(c.assignment_id, s);
      }
    }
  }

  // ── Destinations: hospitals for casualty transport, shelters for evacuation ──
  const nHosp = hospitals.length;
  const hospitalOptions = (incidentId: string, need: number) => {
    const k = incIndex.get(incidentId);
    if (k === undefined) return [];
    const inc = incById.get(incidentId)!;
    const preferred = DEMAND_EVIDENCE_POLICY.hospitalPreferred[inc.type as keyof typeof DEMAND_EVIDENCE_POLICY.hospitalPreferred];
    return hospitals
      .map((h, j) => ({ h, eta: facilityMatrix.durations_s[k][j] }))
      .filter(({ h, eta }) => eta !== null && freeCapacity(h) >= need
        && DEMAND_EVIDENCE_POLICY.hospitalRequired.some((cap) => (h.capabilities ?? []).includes(cap)))
      .sort((a, b) => Number((b.h.capabilities ?? []).includes(preferred ?? '')) - Number((a.h.capabilities ?? []).includes(preferred ?? '')) || a.eta! - b.eta!);
  };
  const sheltersOut: Plan['shelters'] = [];
  for (const d of demands) {
    if (!d.shelter_need) continue;
    const k = incIndex.get(d.incident_id);
    const opts = k === undefined ? [] : shelters
      .map((sh, j) => ({ sh, eta: facilityMatrix.durations_s[k][nHosp + j] }))
      .filter((o) => o.eta !== null && freeCapacity(o.sh) > 0)
      .sort((a, b) => a.eta! - b.eta!);
    const need = d.shelter_need;
    const fit = opts.find((o) => need < 0 || freeCapacity(o.sh) >= need) ?? opts[0];
    const totalFree = opts.reduce((a, o) => a + freeCapacity(o.sh), 0);
    sheltersOut.push({
      incident_id: d.incident_id, need, shelter_id: fit?.sh.id ?? null, name: fit?.sh.name ?? null, free: fit ? freeCapacity(fit.sh) : 0,
      warning: !fit ? 'no reachable shelter with free capacity' : need > 0 && totalFree < need ? `reachable shelter capacity (${totalFree}) below need (${need})` : null,
    });
  }

  // ── Open slots and scarcity ──
  const openSlots = allSlots.filter((s) => !pinnedBy.has(s.id));
  const scarcity = scarcityByType(openSlots, free);
  const rejected = new Set(input.rejections.map((x) => pairKey(x.resource_id, x.incident_id)));
  const gpsFresh = (r: AllocResource) => !!r.location_updated_at && input.now.getTime() - new Date(r.location_updated_at).getTime() < C.gpsFreshMin * 60_000;

  // Progress of an en-route unit: how much of its planned trip is already done.
  const progressOf = (c: Commitment) => {
    const pr = pairRoutes.get(pairKey(c.resource_id, c.incident_id));
    if (pr?.status !== 'ok' || !c.eta_minutes) return 0.5;
    return Math.min(1, Math.max(0, 1 - pr.eta_s / 60 / c.eta_minutes));
  };

  const edgeCache = new Map<string, Edge | { reason: string }>();
  const cIndex = new Map(candidates.map((r, k) => [r.id, k]));
  const edge = (r: AllocResource, s: DemandSlot, allowMoves: boolean): Edge | { reason: string } => {
    const key = `${allowMoves ? 'm' : 'n'}|${r.id}|${s.id}`;
    const cached = edgeCache.get(key);
    if (cached) return cached;
    const c = commitByResource.get(r.id);
    const own = c && pinnedBy.get(s.id)?.assignment_id === c.assignment_id;
    let out: Edge | { reason: string };
    const feas = own ? { ok: true as const } : structuralFeasibility(r, s, { rejectedPairs: rejected, commitment: c, allowMoves });
    const inc = incById.get(s.incident_id)!;
    const k = incIndex.get(s.incident_id);
    if (!feas.ok) out = { reason: feas.reason };
    else if (k === undefined) out = { reason: 'incident has no location' };
    else if (s.capacity_need > 0 && !hospitalOptions(s.incident_id, s.capacity_need).length) out = { reason: 'no reachable hospital with free beds' };
    else {
      const verified = pairRoutes.get(pairKey(r.id, s.incident_id));
      const tableEta = matrix.durations_s[cIndex.get(r.id)!][k];
      const route: PairRoute = verified ?? (tableEta === null
        ? { status: 'infeasible', reason: 'no road route' }
        : { status: 'ok', eta_s: tableEta, distance_m: matrix.distances_m[cIndex.get(r.id)!][k], via: 'table' });
      if (route.status !== 'ok') out = { reason: route.reason };
      else if (route.eta_s / 60 > C.maxResponseMin) out = { reason: `road ETA ${Math.round(route.eta_s / 60)} min exceeds ${C.maxResponseMin} min window` };
      else {
        // A move pays its reassignment cost plus the minimum-improvement threshold, so the solver only
        // keeps moves that are individually worth it (no cascades of marginal swaps).
        const reassign = own ? 0 : reassignmentCost(c, s.incident_id, c ? progressOf(c) : 0);
        const moveCost = reassign > 0 ? reassign + C.minImprovementForMoves : 0;
        const b = computeUtility({
          priority: inc.priority, priorityScore: inc.priority_score, slot: s, resource: r,
          etaMin: route.eta_s / 60, scarcity: scarcity[s.resource_type] ?? 0, moveCost,
        });
        // Keeping a unit where it is always has (small) positive value: never an implicit cancellation.
        const net = own ? Math.max(b.net, 1e-4) : b.net;
        out = { net, breakdown: b, route, verified: !!verified, moveCost };
      }
    }
    edgeCache.set(key, out);
    return out;
  };
  const invalidatePair = (resourceId: string, incidentId: string) => {
    for (const k of [...edgeCache.keys()]) {
      const [, rid, sid] = k.split('|');
      if (rid === resourceId && sid.startsWith(`${incidentId}:`)) edgeCache.delete(k);
    }
  };

  // ── Solve (exact) with route verification of every selected pair ──
  let iterations = 0;
  let solveMs = 0;
  const solve = async (R: AllocResource[], S: DemandSlot[], allowMoves: boolean) => {
    for (;;) {
      iterations++;
      const weights = R.map((r) => S.map((s) => { const e = edge(r, s, allowMoves); return 'net' in e ? e.net : null; }));
      const t = performance.now();
      const res = maxWeightAssignment(weights, S.length);
      solveMs += performance.now() - t;
      const unverified = res.pairs.filter(([ri, si]) => { const e = edge(R[ri], S[si], allowMoves); return 'net' in e && !e.verified; });
      if (!unverified.length || iterations > C.maxVerifyIterations * 2) return { res, R, S, converged: !unverified.length };
      for (const [ri, si] of unverified) {
        const r = R[ri];
        const inc = incById.get(S[si].incident_id)!;
        routeChecks++;
        const v = await verifiedRoute(pos(r), pos(inc), input.blockedRoads);
        pairRoutes.set(pairKey(r.id, inc.id), v.status === 'ok'
          ? { status: 'ok', eta_s: v.route.duration_s, distance_m: v.route.distance_m, via: v.via }
          : { status: 'infeasible', reason: v.status === 'blocked' ? `route blocked (${v.blocked_by.length} blocked road${v.blocked_by.length > 1 ? 's' : ''}, no detour found)` : 'no road route' });
        invalidatePair(r.id, inc.id);
      }
    }
  };

  let noMoves: Awaited<ReturnType<typeof solve>>;
  let withMoves: Awaited<ReturnType<typeof solve>> | null = null;
  const feasibleCommitments = movable.map((r) => commitByResource.get(r.id)!).filter((c) => slotOfAssignment.has(c.assignment_id) && pinnedBy.get(slotOfAssignment.get(c.assignment_id)!.id)?.assignment_id === c.assignment_id);
  try {
    noMoves = await solve(free, openSlots, false);
    if (input.allowMoves && movable.length) {
      const stayingSlots = feasibleCommitments.map((c) => slotOfAssignment.get(c.assignment_id)!);
      withMoves = await solve([...free, ...movable], [...openSlots, ...stayingSlots], true);
    }
  } catch (err) {
    if (!(err instanceof RoutingUnavailableError)) throw err;
    const slots = allSlots.map((s) => ({ slot: s, status: pinnedBy.has(s.id) ? 'kept' as const : 'unmet' as const, reason: pinnedBy.has(s.id) ? undefined : 'road routing unavailable' }));
    return emptyPlan(input, version, t0, `Road routing unavailable during route verification: ${err.message}`, slots);
  }
  if (!noMoves.converged || (withMoves && !withMoves.converged)) warnings.push('route verification did not fully converge; unverified pairs were dropped');

  // Value of keeping movable units where they are (so both plans are compared on equal terms).
  const stayValue = feasibleCommitments.reduce((sum, c) => {
    const e = edge(resById.get(c.resource_id)!, slotOfAssignment.get(c.assignment_id)!, true);
    return sum + ('net' in e ? e.net : 0);
  }, 0);
  const objNoMoves = noMoves.res.total + stayValue;
  const objWithMoves = withMoves ? withMoves.res.total : null;
  const useMoves = withMoves !== null && objWithMoves! - objNoMoves >= C.minImprovementForMoves;
  const chosen = useMoves ? withMoves! : noMoves;
  const chosenAllowMoves = useMoves;

  // ── Turn the chosen solution into proposals ──
  const proposals: Proposal[] = [];
  const filledSlots = new Set<string>();
  const movedAssignments = new Set<string>();
  for (const [ri, si] of chosen.res.pairs) {
    const r = chosen.R[ri];
    const c = commitByResource.get(r.id);
    if (c && c.incident_id !== chosen.S[si].incident_id) movedAssignments.add(c.assignment_id);
  }
  for (const [ri, si] of chosen.res.pairs) {
    const r = chosen.R[ri];
    const s = chosen.S[si];
    const e = edge(r, s, chosenAllowMoves);
    if (!('net' in e) || !e.verified) continue;
    filledSlots.add(s.id);
    const c = commitByResource.get(r.id);
    const pinned = pinnedBy.get(s.id);
    // Staying with its own incident is never a move, whichever slot number it occupies.
    if (c && (pinned?.assignment_id === c.assignment_id || c.incident_id === s.incident_id)) {
      outcomes.set(s.id, { slot: s, status: 'kept', resource_id: r.id, assignment_id: c.assignment_id });
      continue;
    }
    const inc = incById.get(s.incident_id)!;
    const kind: Proposal['kind'] = c ? 'move'
      : replacesBySlot.has(s.id) ? 'replacement'
        : pinned && movedAssignments.has(pinned.assignment_id) ? 'backfill' : 'new';
    const alternatives: Alternative[] = [];
    const reasons = new Map<string, string>();
    for (const other of chosen.R) {
      if (other.id === r.id || other.type !== s.resource_type) continue;
      const oe = edge(other, s, chosenAllowMoves);
      if ('net' in oe) alternatives.push({ resource_id: other.id, name: other.name, net: round(oe.net), eta_min: oe.breakdown.eta_min });
      else if (!reasons.has(oe.reason)) reasons.set(oe.reason, other.name);
    }
    alternatives.sort((a, b) => (b.net ?? 0) - (a.net ?? 0));
    const explained = [
      ...alternatives.slice(0, C.explainAlternatives),
      ...[...reasons.entries()].slice(0, C.explainAlternatives).map(([reason, name]) => ({ resource_id: '', name, reason })),
    ];
    proposals.push({
      key: `${s.incident_id}|${r.id}|${s.resource_type}#${s.index}`,
      incident_id: s.incident_id, resource_id: r.id, resource_name: r.name, slot: s, kind,
      replaces_assignment_id: kind === 'move' ? c!.assignment_id : kind === 'replacement' ? replacesBySlot.get(s.id)! : null,
      move_from_incident_id: kind === 'move' ? c!.incident_id : null,
      backfill_for_assignment_id: kind === 'backfill' ? pinned!.assignment_id : null,
      eta_min: e.breakdown.eta_min, distance_m: e.route.distance_m, route_via: e.route.via, gps_fresh: gpsFresh(r),
      utility: e.breakdown, incident_priority: inc.priority, incident_priority_score: inc.priority_score,
      destination: null, destination_warning: null, alternatives: explained,
    });
    outcomes.set(s.id, { slot: s, status: 'proposed', resource_id: r.id });
  }

  // Hospital beds are shared: reserve them in order of proposal value (documented approximation).
  const reservedBeds = new Map<string, number>();
  for (const p of [...proposals].sort((a, b) => b.utility.net - a.utility.net)) {
    if (p.slot.capacity_need <= 0) continue;
    const opt = hospitalOptions(p.incident_id, p.slot.capacity_need)
      .find(({ h }) => freeCapacity(h) - (reservedBeds.get(h.id) ?? 0) >= p.slot.capacity_need);
    if (opt) {
      reservedBeds.set(opt.h.id, (reservedBeds.get(opt.h.id) ?? 0) + p.slot.capacity_need);
      p.destination = { type: 'hospital', id: opt.h.id, name: opt.h.name, eta_min: opt.eta === null ? null : Math.round(opt.eta / 6) / 10, free_beds: freeCapacity(opt.h) - (reservedBeds.get(opt.h.id) ?? 0) };
    } else {
      p.destination_warning = 'hospital beds exhausted by higher-priority proposals in this plan';
    }
  }

  // ── Slot outcomes (kept / proposed / unmet with a reason) ──
  const unitsOfType = (t: string) => mobile.filter((r) => r.type === t);
  for (const s of allSlots) {
    if (outcomes.has(s.id)) continue;
    const pinned = pinnedBy.get(s.id);
    if (pinned && !movedAssignments.has(pinned.assignment_id)) {
      outcomes.set(s.id, { slot: s, status: 'kept', resource_id: pinned.resource_id, assignment_id: pinned.assignment_id });
      continue;
    }
    if (!unitsOfType(s.resource_type).length) { unmet(s, `no ${s.resource_type.replace('_', ' ')} units in the fleet`); continue; }
    const pool = chosenAllowMoves ? [...free, ...movable] : free;
    const reasons = new Set<string>();
    let anyFeasible = false;
    for (const r of pool.filter((x) => x.type === s.resource_type)) {
      const e = edge(r, s, chosenAllowMoves);
      if ('net' in e) anyFeasible = true; else reasons.add(e.reason);
    }
    unmet(s, anyFeasible
      ? 'feasible units are allocated to higher-utility slots'
      : pool.some((x) => x.type === s.resource_type) ? [...reasons].slice(0, 3).join('; ') : `no free ${s.resource_type.replace('_', ' ')} units`);
  }
  if (!filledSlots.size && openSlots.length) warnings.push('no open demand slot could be filled');

  const slots = allSlots.map((s) => outcomes.get(s.id)!);
  return {
    run_id: input.runId, trigger: input.trigger, degraded: false, degraded_reason: null,
    routing_backend: getRoutingProvider()?.id ?? null, blocked_version: version,
    mode: useMoves ? 'with_moves' : 'no_moves',
    objective: round(useMoves ? objWithMoves! : objNoMoves),
    objective_no_moves: round(objNoMoves), objective_with_moves: objWithMoves === null ? null : round(objWithMoves),
    proposals, slots, infeasible_commitments: infeasibleCommitments, shelters: sheltersOut, warnings,
    stats: {
      incidents: incidents.length, slots: allSlots.length, open_slots: openSlots.length, resources_considered: candidates.length,
      proposals: proposals.length, moves: proposals.filter((p) => p.kind === 'move').length,
      unmet_essential: slots.filter((o) => o.slot.essential && o.status === 'unmet').length,
      verify_iterations: iterations, route_checks: routeChecks, solve_ms: Math.round(solveMs * 10) / 10,
      total_ms: Math.round(performance.now() - t0),
    },
  };
}
