/**
 * Optimizer tests (pure, deterministic mock routing; no database, no network).
 *   npx tsx server/scripts/test-allocation.ts
 */
import { check, section, summary } from './alloc-test-lib.js';
import { MockRoutingProvider, loadRoutingModule } from './mock-routing.js';
import { planAllocation, type AllocIncident, type PlanInput } from '../src/services/allocation/optimizer.js';
import { buildIncidentDemand } from '../src/services/allocation/demand.js';
import { etaValue, riskWeight } from '../src/services/allocation/utility.js';
import type { AllocResource, Commitment } from '../src/services/allocation/candidates.js';

const routing = await loadRoutingModule();
const mock = new MockRoutingProvider();
routing.setRoutingProvider(mock);

// ── Builders ──
let seq = 0;
const BASE = { lat: 19.0, lng: 72.85 };
const at = (dLatKm: number, dLngKm: number) => ({ lat: BASE.lat + dLatKm / 111, lng: BASE.lng + dLngKm / 111 });

function res(type: string, name: string, p: { lat: number; lng: number }, extra: Partial<AllocResource> = {}): AllocResource {
  return {
    id: `r${++seq}-${name}`, type, name, status: 'available', location_lat: p.lat, location_lng: p.lng, location_updated_at: null,
    capacity: type === 'ambulance' ? 2 : type === 'hospital' ? 300 : type === 'shelter' ? 200 : 1, current_load: 0,
    capabilities: type === 'fire_truck' ? ['fire_suppression', 'rescue'] : type === 'hospital' ? ['emergency', 'trauma'] : type === 'police' ? ['evacuation'] : [],
    assigned_incident_id: null, ...extra,
  };
}
function inc(type: string, priority: string, score: number, p: { lat: number; lng: number }, extra: Partial<AllocIncident> = {}): AllocIncident {
  return {
    id: `i${++seq}-${type}-${priority}`, type, status: 'triage', priority, priority_score: score,
    location_lat: p.lat, location_lng: p.lng, parent_incident_id: null, people_affected: 0, injuries: 0, ...extra,
  };
}
const hospital = res('hospital', 'Hospital', at(0, 3));
function input(incidents: AllocIncident[], resources: AllocResource[], extra: Partial<PlanInput> = {}): PlanInput {
  return {
    runId: `run-${++seq}`, trigger: 'test', allowMoves: true, now: new Date(), incidents,
    resources: [...resources, hospital], commitments: [], rejections: [], blockedRoads: [], ...extra,
  };
}
const byResource = (plan: Awaited<ReturnType<typeof planAllocation>>, id: string) => plan.proposals.filter((p) => p.resource_id === id);

// ── Unit pieces ──
section('Utility pieces');
check(riskWeight(100) === 1 && Math.abs(riskWeight(50) - 0.25) < 1e-9 && Math.abs(riskWeight(20) - 0.04) < 1e-9, 'risk weight = (score/100)^2');
check(etaValue(8, 'critical') === 1 && etaValue(16, 'critical') < etaValue(16, 'low'), 'ETA value: full within target, decays faster for CRITICAL');

section('Demand generation');
{
  const collapse = buildIncidentDemand({ id: 'c', type: 'building_collapse', priority: 'high', risk_assessment: { status: 'ok', evidence: { trapped: 4, injured: 5, search_rescue: 1 } } });
  const ft = collapse.slots.filter((s) => s.resource_type === 'fire_truck');
  const amb = collapse.slots.filter((s) => s.resource_type === 'ambulance');
  check(ft.length === 2 && ft[0].required_caps.includes('rescue') && ft[0].essential, 'collapse HIGH + trapped → 2 fire trucks, first requires rescue', collapse.slots);
  check(amb.length === 3 && amb.map((a) => a.capacity_need).join() === '2,2,1', 'injured 5 → 3 ambulances carrying 2,2,1 patients', amb.map((a) => a.capacity_need));
  const gas = buildIncidentDemand({ id: 'g', type: 'gas_leak', priority: 'medium' });
  check(gas.slots.some((s) => s.resource_type === 'fire_truck' && s.required_caps.includes('hazmat')), 'gas leak → fire truck requiring hazmat');
  const flood = buildIncidentDemand({ id: 'f', type: 'flood', priority: 'high', people_affected: 500 });
  check(flood.shelter_need === 500 && flood.slots.some((s) => s.resource_type === 'police' && s.required_caps.includes('evacuation')), 'flood with 500 affected → evacuation police + shelter need 500');
  const low = buildIncidentDemand({ id: 'l', type: 'fire', priority: 'low' });
  const crit = buildIncidentDemand({ id: 'k', type: 'fire', priority: 'critical' });
  check(low.slots.length < crit.slots.length, `fire LOW (${low.slots.length} slots) < fire CRITICAL (${crit.slots.length} slots)`);
  check(new Set(crit.slots.map((s) => s.id)).size === crit.slots.length, 'slot ids are unique');
}

section('Routing: blocked-road geometry (mock routes)');
{
  const from = at(0, 0);
  const to = at(4, 4);
  const road = { id: 'b1', start_lat: from.lat, start_lng: at(0, 1).lng, end_lat: from.lat, end_lng: at(0, 3).lng };
  const crossing = { id: 'b2', start_lat: at(-1, 2).lat, start_lng: at(0, 2).lng, end_lat: at(1, 2).lat, end_lng: at(0, 2).lng };
  const [fastest] = await mock.routes(from, to, { alternatives: false });
  check(routing.routeUsesBlockedRoad(fastest.coordinates, road), 'route travelling along a blocked segment is detected');
  check(!routing.routeUsesBlockedRoad(fastest.coordinates, crossing), 'route merely crossing a blocked segment is not treated as using it');
  const v = await routing.verifiedRoute(from, to, [road]);
  check(v.status === 'ok' && v.via === 'alternative', 'fastest route blocked → alternative route chosen', v.status === 'ok' ? v.via : v);
  const altRoad = { id: 'b3', start_lat: at(1, 0).lat, start_lng: from.lng, end_lat: at(3, 0).lat, end_lng: from.lng };
  const v2 = await routing.verifiedRoute(from, to, [road, altRoad]);
  check(v2.status === 'ok' && v2.via === 'detour', 'both routes blocked → detour via waypoint', v2.status === 'ok' ? v2.via : v2);
  mock.allowDetours = false;
  routing.clearRoutingCache();
  const v3 = await routing.verifiedRoute(from, to, [road, altRoad]);
  check(v3.status === 'blocked', 'no detour available → pair reported blocked (infeasible)', v3);
  mock.allowDetours = true;
  routing.clearRoutingCache();
}

// ── Hard constraints ──
section('Hard constraints are infeasible edges');
{
  const gas = inc('gas_leak', 'critical', 100, at(0, 0));
  const nearNoHazmat = res('fire_truck', 'Near-no-hazmat', at(0.2, 0));
  const farHazmat = res('fire_truck', 'Far-hazmat', at(6, 6), { capabilities: ['fire_suppression', 'hazmat', 'rescue'] });
  const unavailable = res('police', 'Unavailable-police', at(0.1, 0), { status: 'unavailable' });
  const police = res('police', 'Police', at(5, 0));
  const hosp = res('hospital', 'Nearby-hospital-as-unit', at(0.1, 0.1));
  const plan = await planAllocation(input([gas], [nearNoHazmat, farHazmat, unavailable, police, hosp]));
  const hazmatSlot = plan.proposals.find((p) => p.slot.required_caps.includes('hazmat'));
  check(hazmatSlot?.resource_id === farHazmat.id, 'hazmat slot gets the far hazmat truck, never the near one lacking hazmat');
  check(!byResource(plan, unavailable.id).length, 'unavailable unit never proposed');
  check(!plan.proposals.some((p) => p.resource_id === hosp.id || p.resource_id === hospital.id), 'hospitals are never dispatched');
  check(byResource(plan, police.id).length === 1, 'available police unit fills the police slot');

  const injured = inc('road_accident', 'high', 80, at(0, 0), { risk_assessment: { status: 'ok', evidence: { injured: 2 } } });
  const fullAmb = res('ambulance', 'Full-ambulance', at(0.1, 0), { current_load: 2 });
  const emptyAmb = res('ambulance', 'Empty-ambulance', at(3, 3));
  const plan2 = await planAllocation(input([injured], [fullAmb, emptyAmb, res('police', 'P', at(1, 1)), res('road_crew', 'RC', at(1, 1))]));
  const transport = plan2.proposals.find((p) => p.slot.capacity_need >= 2);
  check(transport?.resource_id === emptyAmb.id && !byResource(plan2, fullAmb.id).some((p) => p.slot.capacity_need > 0), 'ambulance with no free seats cannot take a 2-patient slot');
  check(transport?.destination?.type === 'hospital', 'casualty transport gets a destination hospital with free beds');

  // Route blocked with no detour → infeasible even though nearest.
  mock.allowDetours = false;
  const fire = inc('fire', 'low', 30, at(0, 0));
  const blockedTruck = res('fire_truck', 'Blocked-truck', at(0, 1));
  const okTruck = res('fire_truck', 'Ok-truck', at(0, -4));
  const wall = { id: 'w1', start_lat: at(-0.05, 0.9).lat, start_lng: at(0, 0.9).lng, end_lat: at(0.05, 0.1).lat, end_lng: at(0, 0.1).lng };
  const wallAlong = { id: 'w2', start_lat: at(0, 0.8).lat, start_lng: at(0, 0.8).lng, end_lat: at(0, 0.2).lat, end_lng: at(0, 0.2).lng };
  const plan3 = await planAllocation(input([fire], [blockedTruck, okTruck], { blockedRoads: [wall, wallAlong] }));
  check(!byResource(plan3, blockedTruck.id).length && byResource(plan3, okTruck.id).length === 1, 'unit whose only route uses a blocked road is not selected', plan3.proposals.map((p) => p.resource_name));
  mock.allowDetours = true;
  routing.clearRoutingCache();

  // Beyond the response window.
  const farOnly = res('fire_truck', 'Very-far', at(40, 40));
  const plan4 = await planAllocation(input([inc('fire', 'low', 30, at(0, 0))], [farOnly]));
  check(!plan4.proposals.length && plan4.slots.some((s) => s.reason?.includes('exceeds')), 'unit beyond the max response window is infeasible', plan4.slots.map((s) => s.reason));
}

// ── Global allocation ──
section('Global allocation accounts for risk');
{
  // Both incidents have a casualty, so both genuinely need the single ambulance.
  const hurt = { risk_assessment: { status: 'ok', evidence: { injured: 1 } } };
  const critical = inc('road_accident', 'critical', 100, at(0, 4), hurt);
  const low = inc('road_accident', 'low', 20, at(0, 0.5), hurt);
  const amb = res('ambulance', 'Only-ambulance', at(0, 0)); // closer to the LOW incident
  const plan = await planAllocation(input([low, critical], [amb]));
  check(buildIncidentDemand(low).slots.some((s) => s.resource_type === 'ambulance'), 'precondition: the LOW incident has an ambulance slot');
  check(byResource(plan, amb.id).length === 1 && byResource(plan, amb.id)[0].incident_id === critical.id, 'single ambulance goes to the CRITICAL incident even though LOW is closer');
  const lowOnly = await planAllocation(input([low], [amb]));
  check(byResource(lowOnly, amb.id)[0]?.incident_id === low.id, 'control: without competition the same ambulance is proposed for the LOW incident');

  const f1 = inc('fire', 'high', 75, at(0, 0));
  const f2 = inc('fire', 'high', 75, at(0, 2));
  const truck = res('fire_truck', 'Single-truck', at(0, 1));
  const plan2 = await planAllocation(input([f1, f2], [truck]));
  check(byResource(plan2, truck.id).length === 1, 'double booking impossible: one unit, two competing incidents → one proposal');
  const perResource = new Map<string, number>();
  const many = await planAllocation(input(
    Array.from({ length: 8 }, (_, k) => inc(['fire', 'flood', 'building_collapse', 'road_accident'][k % 4], ['critical', 'high', 'medium', 'low'][k % 4], 95 - k * 10, at(k, k % 3))),
    Array.from({ length: 10 }, (_, k) => res(['fire_truck', 'ambulance', 'police', 'road_crew'][k % 4], `U${k}`, at(k % 5, k % 4))),
  ));
  for (const p of many.proposals) perResource.set(p.resource_id, (perResource.get(p.resource_id) ?? 0) + 1);
  check([...perResource.values()].every((n) => n === 1), 'multi-incident plan: every unit used at most once', Object.fromEntries(perResource));
  check(many.stats.incidents === 8 && many.proposals.length > 0, 'all 8 incidents optimized in one run');
}

// ── Reallocation ──
section('Dynamic reallocation');
{
  const a = inc('fire', 'high', 75, at(0, 0));
  const r1 = res('fire_truck', 'R1', at(0, 1), { status: 'unavailable', assigned_incident_id: a.id });
  const r2 = res('fire_truck', 'R2', at(0, 3));
  const c1: Commitment = { assignment_id: 'as-r1', resource_id: r1.id, incident_id: a.id, status: 'en_route', eta_minutes: 5, updated_at: new Date().toISOString() };
  const plan = await planAllocation(input([a], [r1, r2, res('ambulance', 'A', at(1, 0)), res('police', 'P', at(1, 1))], { commitments: [c1] }));
  const rep = plan.proposals.find((p) => p.kind === 'replacement');
  check(plan.infeasible_commitments.some((x) => x.assignment_id === 'as-r1'), 'unit unavailable → its assignment marked infeasible');
  check(rep?.resource_id === r2.id && rep.replaces_assignment_id === 'as-r1', 'replacement proposed for the vacated slot, linked to the replaced assignment');

  // Road blocked on the way.
  mock.allowDetours = false;
  const b = inc('fire', 'high', 75, at(0, 0));
  const r3 = res('fire_truck', 'R3', at(0, 2), { status: 'en_route', assigned_incident_id: b.id });
  const r4 = res('fire_truck', 'R4', at(0, -3));
  const c3: Commitment = { assignment_id: 'as-r3', resource_id: r3.id, incident_id: b.id, status: 'en_route', eta_minutes: 6, updated_at: new Date().toISOString() };
  const block = [
    { id: 'x1', start_lat: at(0, 1.8).lat, start_lng: at(0, 1.8).lng, end_lat: at(0, 0.2).lat, end_lng: at(0, 0.2).lng },
    { id: 'x2', start_lat: at(0, 2).lat, start_lng: at(0, 2).lng, end_lat: at(0, 2).lat + 0.00001, end_lng: at(0, 0.2).lng },
  ];
  const plan2 = await planAllocation(input([b], [r3, r4, res('ambulance', 'A', at(1, 0)), res('police', 'P', at(1, 1))], { commitments: [c3], blockedRoads: block }));
  check(plan2.infeasible_commitments.some((x) => x.assignment_id === 'as-r3' && x.reason.includes('blocked')), 'route blocked → current assignment infeasible', plan2.infeasible_commitments);
  check(plan2.proposals.some((p) => p.kind === 'replacement' && p.resource_id === r4.id && p.replaces_assignment_id === 'as-r3'), 'replacement for the blocked unit proposed', plan2.proposals.map((p) => [p.kind, p.resource_name]));
  mock.allowDetours = true;
  routing.clearRoutingCache();

  // New CRITICAL incident; only unit is committed (dispatched) to a LOW incident.
  const lowInc = inc('road_accident', 'low', 20, at(0, 5), { risk_assessment: { status: 'ok', evidence: { injured: 1 } } });
  const critInc = inc('road_accident', 'critical', 100, at(0, 1));
  const amb = res('ambulance', 'Amb', at(0, 0), { status: 'dispatched', assigned_incident_id: lowInc.id });
  const cAmb: Commitment = { assignment_id: 'as-amb', resource_id: amb.id, incident_id: lowInc.id, status: 'dispatched', eta_minutes: 10, updated_at: new Date().toISOString() };
  const plan3 = await planAllocation(input([lowInc, critInc], [amb], { commitments: [cAmb] }));
  const move = plan3.proposals.find((p) => p.kind === 'move');
  check(plan3.mode === 'with_moves' && move?.resource_id === amb.id && move.incident_id === critInc.id && move.replaces_assignment_id === 'as-amb', 'new CRITICAL incident → move proposed from LOW incident (gain beats reassignment cost)', { mode: plan3.mode, gain: [plan3.objective_no_moves, plan3.objective_with_moves] });
  check(move ? move.utility.reassignment_cost > 0 : false, 'move carries a positive reassignment cost');
  check((plan3.objective_no_moves ?? 0) > 0, 'precondition: the unit was filling a real slot at the LOW incident (stay value > 0)', plan3.objective_no_moves);
  const noMoves = await planAllocation(input([lowInc, critInc], [amb], { commitments: [cAmb], allowMoves: false }));
  check(!noMoves.proposals.some((p) => p.kind === 'move'), 'control: with moves disabled the committed unit stays');

  // Small improvement → no churn.
  const medA = inc('road_accident', 'medium', 50, at(0, 3));
  const medB = inc('road_accident', 'medium', 52, at(0, 2.8));
  const amb2 = res('ambulance', 'Amb2', at(0, 0), { status: 'en_route', assigned_incident_id: medA.id });
  const cAmb2: Commitment = { assignment_id: 'as-amb2', resource_id: amb2.id, incident_id: medA.id, status: 'en_route', eta_minutes: 12, updated_at: new Date().toISOString() };
  const plan4 = await planAllocation(input([medA, medB], [amb2], { commitments: [cAmb2] }));
  check(plan4.mode === 'no_moves' && !plan4.proposals.some((p) => p.kind === 'move'), 'marginal improvement below threshold → no reshuffle', { with: plan4.objective_with_moves, without: plan4.objective_no_moves });

  // On-scene units are locked.
  const scene = inc('road_accident', 'low', 20, at(0, 1), { risk_assessment: { status: 'ok', evidence: { injured: 1 } } });
  const urgent = inc('road_accident', 'critical', 100, at(0, 2));
  const onScene = res('ambulance', 'OnScene', at(0, 1), { status: 'on_scene', assigned_incident_id: scene.id });
  const cScene: Commitment = { assignment_id: 'as-scene', resource_id: onScene.id, incident_id: scene.id, status: 'arrived', eta_minutes: 3, updated_at: new Date().toISOString() };
  const plan5 = await planAllocation(input([scene, urgent], [onScene], { commitments: [cScene] }));
  check(!byResource(plan5, onScene.id).length, 'on-scene unit is never moved, even for a CRITICAL incident');

  // Resource becomes free → unmet slot filled.
  const waiting = inc('fire', 'medium', 50, at(0, 0));
  const busy = res('fire_truck', 'Busy', at(0, 1), { status: 'dispatched', assigned_incident_id: 'elsewhere' });
  const before = await planAllocation(input([waiting], [busy], { allowMoves: false }));
  const freed = await planAllocation(input([waiting], [{ ...busy, status: 'available', assigned_incident_id: null }]));
  check(!before.proposals.length && freed.proposals.some((p) => p.resource_id === busy.id), 'unit becomes free → previously unmet slot now proposed');
}

section('Stability (no churn)');
{
  const { rng } = await import('./alloc-test-lib.js');
  let replanMoves = 0;
  let maxCascade = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const rand = rng(seed);
    const kinds = ['fire', 'flood', 'building_collapse', 'gas_leak', 'road_accident'];
    const classes: [string, number][] = [['critical', 95], ['high', 75], ['medium', 50], ['low', 20]];
    const incidents = Array.from({ length: 8 }, (_, k) => {
      const [p, sc] = classes[Math.floor(rand() * 4)];
      return inc(kinds[Math.floor(rand() * 5)], p, sc, at(rand() * 10, rand() * 10), { risk_assessment: { status: 'ok', evidence: { injured: Math.floor(rand() * 4), trapped: rand() < 0.3 ? 2 : 0 } } });
    });
    const units = Array.from({ length: 12 }, (_, k) => res(['fire_truck', 'ambulance', 'police', 'road_crew'][k % 4], `S${seed}U${k}`, at(rand() * 10, rand() * 10), { capabilities: ['fire_suppression', 'rescue', 'hazmat', 'evacuation'] }));
    const p1 = await planAllocation(input(incidents, units));
    const commitments: Commitment[] = p1.proposals.map((p, k) => ({ assignment_id: `s${seed}a${k}`, resource_id: p.resource_id, incident_id: p.incident_id, status: 'dispatched', eta_minutes: Math.round(p.eta_min), updated_at: new Date().toISOString() }));
    const committed = units.map((u) => { const c = commitments.find((x) => x.resource_id === u.id); return c ? { ...u, status: 'dispatched', assigned_incident_id: c.incident_id } : u; });
    const p2 = await planAllocation(input(incidents, committed, { commitments }));
    replanMoves += p2.stats.moves;
    const newCrit = inc('building_collapse', 'critical', 100, at(5, 5), { risk_assessment: { status: 'ok', evidence: { trapped: 3, injured: 2, search_rescue: 1 } } });
    const p3 = await planAllocation(input([...incidents, newCrit], committed, { commitments }));
    maxCascade = Math.max(maxCascade, p3.proposals.filter((p) => p.kind === 'move' && p.incident_id !== newCrit.id).length);
  }
  check(replanMoves === 0, 're-planning an approved plan with nothing changed proposes no moves (6 random scenarios)', replanMoves);
  check(maxCascade <= 2, `a new CRITICAL incident does not trigger a cascade of marginal swaps elsewhere (max ${maxCascade} knock-on moves)`, maxCascade);
}

section('Coordinator rejection cooldown');
{
  const f = inc('fire', 'high', 75, at(0, 0));
  const t1 = res('fire_truck', 'T1', at(0, 0.5));
  const t2 = res('fire_truck', 'T2', at(0, 4));
  const plan = await planAllocation(input([f], [t1, t2, res('ambulance', 'A', at(1, 0)), res('police', 'P', at(1, 1))], { rejections: [{ resource_id: t1.id, incident_id: f.id }] }));
  check(!byResource(plan, t1.id).length, 'rejected (resource, incident) pair is not proposed again during cooldown');
  check(byResource(plan, t2.id).length === 1, 'the next-best unit is proposed instead');
}

section('Degraded routing');
{
  mock.down = true;
  routing.clearRoutingCache();
  const plan = await planAllocation(input([inc('fire', 'critical', 100, at(0, 0))], [res('fire_truck', 'T', at(0, 1))]));
  check(plan.degraded && !plan.proposals.length && !!plan.degraded_reason, 'routing down → DEGRADED run, no proposals, no straight-line ETA', plan.degraded_reason);
  check(plan.slots.every((s) => s.status === 'unmet' && s.reason === 'road routing unavailable'), 'every open slot explains that routing is unavailable');
  mock.down = false;
  routing.clearRoutingCache();
}

section('Explainability');
{
  const f = inc('fire', 'high', 75, at(0, 0));
  const plan = await planAllocation(input([f], [res('fire_truck', 'T1', at(0, 1)), res('fire_truck', 'T2', at(0, 2)), res('fire_truck', 'NoCap', at(0, 0.5), { capabilities: [] }), res('ambulance', 'A', at(1, 0)), res('police', 'P', at(1, 1))]));
  const p = plan.proposals.find((x) => x.slot.resource_type === 'fire_truck' && x.slot.index === 1);
  check(!!p && p.utility.risk_weight > 0 && p.utility.eta_min > 0 && p.route_via !== 'table', 'proposal carries risk, road ETA and a verified route');
  check(!!p?.alternatives.some((a) => a.reason?.includes('missing required capability')), 'explanation lists why another candidate was infeasible', p?.alternatives);
  check(plan.run_id.startsWith('run-') && plan.stats.solve_ms >= 0, 'run has an id and timing stats');
}

summary('Allocation optimizer');
