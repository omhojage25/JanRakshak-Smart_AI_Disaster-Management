/**
 * Synthetic, scenario-based benchmark: LEGACY greedy matcher (resourceMatcher.ts) vs the NEW
 * global optimizer, on the Mumbai demo fleet with real OSRM road data replayed from a fixture.
 *
 *   npx tsx server/scripts/benchmark-allocation.ts            replay (deterministic, offline)
 *   ROUTING_URL=... npx tsx server/scripts/benchmark-allocation.ts --record   refresh the fixture from live OSRM
 *
 * Results are synthetic scenario evaluations, NOT real-world emergency-response outcomes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng } from './alloc-test-lib.js';
import {
  OsrmProvider, setRoutingProvider, verifiedRoute, clearRoutingCache,
  type BlockedRoadLike, type LatLng, type RoadRoute, type RoutingProvider, type TravelMatrix,
} from '../src/services/routing.js';
import { planAllocation, type AllocIncident } from '../src/services/allocation/optimizer.js';
import { buildIncidentDemand, MOBILE_RESOURCE_TYPES } from '../src/services/allocation/demand.js';
import { riskWeight } from '../src/services/allocation/utility.js';
import { ALLOCATION_CONFIG } from '../src/services/allocation/config.js';
import type { AllocResource, Commitment } from '../src/services/allocation/candidates.js';
import { recommendResources } from '../src/services/resourceMatcher.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = path.join(here, '..', 'benchmarks');
const FIXTURE = path.join(BENCH_DIR, 'routing_fixture.json');
const RECORD = process.argv.includes('--record');

// ── Fixture routing backend ───────────────────────────────────────────────────
const pk = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
interface Fixture { note: string; backend: string; recorded_at: string; points: string[]; durations_s: (number | null)[][]; distances_m: (number | null)[][]; routes: Record<string, RoadRoute[]> }

class FixtureProvider implements RoutingProvider {
  readonly id = 'fixture:mumbai-osrm-v1';
  constructor(private fx: Fixture, private live: OsrmProvider | null) {}
  private idx = () => new Map(this.fx.points.map((k, i) => [k, i]));
  async table(origins: LatLng[], destinations: LatLng[]): Promise<TravelMatrix> {
    const idx = this.idx();
    const look = (p: LatLng) => {
      const i = idx.get(pk(p));
      if (i === undefined) throw new Error(`fixture miss: point ${pk(p)} not in master matrix`);
      return i;
    };
    const oi = origins.map(look);
    const di = destinations.map(look);
    return {
      durations_s: oi.map((i) => di.map((j) => this.fx.durations_s[i][j])),
      distances_m: oi.map((i) => di.map((j) => this.fx.distances_m[i][j])),
    };
  }
  async routes(from: LatLng, to: LatLng, opts: { alternatives: boolean; via?: LatLng }): Promise<RoadRoute[]> {
    const key = `${pk(from)}>${pk(to)}|${opts.alternatives ? 'alt' : 'one'}|${opts.via ? pk(opts.via) : ''}`;
    if (this.fx.routes[key]) return this.fx.routes[key];
    if (!this.live) throw new Error(`fixture miss: route ${key} (re-record with --record)`);
    const r = await this.live.routes(from, to, opts);
    this.fx.routes[key] = r.map((x) => ({ ...x, coordinates: x.coordinates.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5] as [number, number]) }));
    await new Promise((res) => setTimeout(res, 120)); // be polite to the routing server
    return this.fx.routes[key];
  }
}

// ── Scenario inputs ───────────────────────────────────────────────────────────
const fleetFile = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'fleet.json'), 'utf8'));
const FLEET: AllocResource[] = fleetFile.resources.map((r: AllocResource) => ({ ...r, status: 'available', location_updated_at: null, assigned_incident_id: null }));
const SEED_BLOCKED: BlockedRoadLike[] = fleetFile.blocked_roads;
const POOL: [string, number, number][] = [
  ['Dharavi', 19.0430, 72.8527], ['Andheri', 19.1197, 72.8464], ['Dadar', 19.0178, 72.8478], ['Kurla', 19.0726, 72.8794],
  ['Borivali', 19.2307, 72.8567], ['Powai', 19.1176, 72.9060], ['Malad', 19.1870, 72.8489], ['Goregaon', 19.1550, 72.8490],
  ['Juhu', 19.0883, 72.8264], ['Worli', 19.0096, 72.8153], ['Colaba', 18.9067, 72.8147], ['Byculla', 18.9790, 72.8330],
  ['Chembur', 19.0522, 72.9005], ['Ghatkopar', 19.0860, 72.9081], ['Mulund', 19.1726, 72.9425], ['Bandra', 19.0596, 72.8295],
  ['Sion', 19.0390, 72.8619], ['Parel', 18.9960, 72.8410], ['Vikhroli', 19.1110, 72.9280], ['Santacruz', 19.0810, 72.8410],
  ['Kandivali', 19.2047, 72.8526], ['Wadala', 19.0170, 72.8570], ['Matunga', 19.0270, 72.8570], ['Marine Lines', 18.9440, 72.8230],
];
const TYPES = ['fire', 'flood', 'building_collapse', 'gas_leak', 'road_accident'];
const CLASS_SCORES: Record<string, [number, number]> = { critical: [88, 100], high: [65, 85], medium: [40, 60], low: [12, 30] };

function genIncidents(n: number, rand: () => number, tag: string): AllocIncident[] {
  const order = POOL.map((_, i) => i).sort(() => rand() - 0.5);
  return Array.from({ length: n }, (_, k) => {
    const [name, lat, lng] = POOL[order[k % POOL.length]];
    const type = TYPES[Math.floor(rand() * TYPES.length)];
    const x = rand();
    const priority = x < 0.25 ? 'critical' : x < 0.55 ? 'high' : x < 0.8 ? 'medium' : 'low';
    const [lo, hi] = CLASS_SCORES[priority];
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const trapped = (type === 'building_collapse' || rand() < 0.15) ? pick([0, 1, 2, 4, -1]) : 0;
    const evidence = {
      injured: rand() < 0.6 ? pick([1, 2, 3, 5, 8, -1]) : 0,
      trapped, search_rescue: trapped ? 1 : 0, fire: type === 'fire' ? 1 : 0, flood: type === 'flood' ? 1 : 0,
      people_affected: pick([0, 10, 50, 200, 800, -1]),
    };
    return {
      id: `${tag}-${k}-${name}`, type, status: 'triage', priority, priority_score: Math.round(lo + rand() * (hi - lo)),
      title: `${type} at ${name}`, location_lat: lat, location_lng: lng, parent_incident_id: null,
      people_affected: Math.max(0, evidence.people_affected), injuries: Math.max(0, evidence.injured),
      risk_assessment: { status: 'ok', evidence },
    };
  });
}

// ── Evaluation (identical for both methods) ───────────────────────────────────
interface Pair { resource_id: string; incident_id: string }
interface Metrics {
  /** Risk-weighted share of essential slots filled by a physically possible unit (higher is better). */
  essential_coverage_pct: number;
  /** Mean ETA of the first essential unit at CRITICAL incidents that got one. */
  critical_first_unit_eta_min: number | null;
  risk_weighted_mean_eta_min: number | null;
  critical_meeting_target_pct: number | null;
  risk_weighted_unmet_essential: number;
  capability_mismatches: number;
  double_bookings: number;
  blocked_or_infeasible: number;
  assignments: number;
}

async function evaluate(pairs: Pair[], incidents: AllocIncident[], resources: AllocResource[], blocked: BlockedRoadLike[]): Promise<Metrics> {
  const resById = new Map(resources.map((r) => [r.id, r]));
  const incById = new Map(incidents.map((i) => [i.id, i]));
  // A unit can only be in one place: only its FIRST assignment (in decision order) is credited.
  // Every further use is a double booking and fills nothing.
  const firstUse = new Map<string, string>();
  let doubleBookings = 0;
  const credited = pairs.filter((p) => {
    if (!firstUse.has(p.resource_id)) { firstUse.set(p.resource_id, p.incident_id); return true; }
    doubleBookings++;
    return false;
  });

  let mismatches = 0;
  let infeasible = 0;
  let etaNum = 0;
  let etaDen = 0;
  let unmetEssential = 0;
  let critTotal = 0;
  let critMet = 0;
  let essTotal = 0;
  let essFilled = 0;
  const critFirst: number[] = [];
  for (const inc of incidents) {
    const slots = buildIncidentDemand(inc).slots;
    const filled = new Set<string>();
    const R = riskWeight(inc.priority_score);
    const mine = credited.filter((p) => p.incident_id === inc.id);
    const withEta: { r: AllocResource; eta: number | null }[] = [];
    for (const p of mine) {
      const r = resById.get(p.resource_id)!;
      if (!(MOBILE_RESOURCE_TYPES as readonly string[]).includes(r.type) || r.location_lat == null) { withEta.push({ r, eta: null }); continue; }
      const v = await verifiedRoute({ lat: r.location_lat!, lng: r.location_lng! }, { lat: inc.location_lat!, lng: inc.location_lng! }, blocked);
      withEta.push({ r, eta: v.status === 'ok' ? v.route.duration_s / 60 : null });
    }
    withEta.sort((a, b) => (a.eta ?? 1e9) - (b.eta ?? 1e9));
    let firstEssentialEta: number | null = null;
    for (const { r, eta } of withEta) {
      const caps = r.capabilities ?? [];
      const slot = slots.find((s) => !filled.has(s.id) && s.resource_type === r.type
        && s.required_caps.every((c) => caps.includes(c)) && (s.capacity_need <= 0 || r.capacity - r.current_load >= s.capacity_need));
      if (!slot) { mismatches++; continue; }
      if (eta === null || eta > ALLOCATION_CONFIG.maxResponseMin || r.status === 'unavailable') { infeasible++; continue; }
      filled.add(slot.id);
      etaNum += R * eta;
      etaDen += R;
      if (slot.essential && (firstEssentialEta === null || eta < firstEssentialEta)) firstEssentialEta = eta;
    }
    unmetEssential += R * slots.filter((s) => s.essential && !filled.has(s.id)).length;
    essTotal += R * slots.filter((s) => s.essential).length;
    essFilled += R * slots.filter((s) => s.essential && filled.has(s.id)).length;
    if (inc.priority === 'critical') {
      critTotal++;
      if (firstEssentialEta !== null) critFirst.push(firstEssentialEta);
      if (firstEssentialEta !== null && firstEssentialEta <= ALLOCATION_CONFIG.responseTargetMin.critical) critMet++;
    }
  }
  void incById;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    essential_coverage_pct: essTotal ? r2((100 * essFilled) / essTotal) : 100,
    critical_first_unit_eta_min: critFirst.length ? r2(critFirst.reduce((a, b) => a + b, 0) / critFirst.length) : null,
    risk_weighted_mean_eta_min: etaDen ? r2(etaNum / etaDen) : null,
    critical_meeting_target_pct: critTotal ? r2((100 * critMet) / critTotal) : null,
    risk_weighted_unmet_essential: r2(unmetEssential),
    capability_mismatches: mismatches, double_bookings: doubleBookings, blocked_or_infeasible: infeasible, assignments: pairs.length,
  };
}

// ── Methods ───────────────────────────────────────────────────────────────────
const legacyIncident = (i: AllocIncident) => ({
  id: i.id, type: i.type, location_lat: i.location_lat, location_lng: i.location_lng, priority: i.priority,
  priority_score: i.priority_score, people_affected: i.people_affected ?? 0, injuries: i.injuries ?? 0,
});
const clone = (rs: AllocResource[]) => rs.map((r) => ({ ...r }));

function greedyIndependent(incidents: AllocIncident[], resources: AllocResource[], blocked: BlockedRoadLike[]) {
  const t = performance.now();
  const pairs: Pair[] = [];
  for (const inc of incidents) {
    for (const rec of recommendResources(legacyIncident(inc), resources as never, [], blocked as never)) pairs.push({ resource_id: rec.resource_id, incident_id: inc.id });
  }
  return { pairs, ms: performance.now() - t };
}

function greedySequential(incidents: AllocIncident[], resources: AllocResource[], blocked: BlockedRoadLike[]) {
  const t = performance.now();
  const state = clone(resources);
  const pairs: Pair[] = [];
  for (const inc of incidents) {
    for (const rec of recommendResources(legacyIncident(inc), state as never, [], blocked as never)) {
      pairs.push({ resource_id: rec.resource_id, incident_id: inc.id });
      const r = state.find((x) => x.id === rec.resource_id)!;
      r.status = 'dispatched';
      r.assigned_incident_id = inc.id;
    }
  }
  return { pairs, ms: performance.now() - t };
}

async function optimizer(incidents: AllocIncident[], resources: AllocResource[], blocked: BlockedRoadLike[], commitments: Commitment[] = []) {
  const plan = await planAllocation({
    runId: 'bench', trigger: 'benchmark', allowMoves: true, now: new Date('2026-09-27T12:00:00Z'),
    incidents, resources, commitments, rejections: [], blockedRoads: blocked,
  });
  return plan;
}

// ── Straight-line vs road ETA ─────────────────────────────────────────────────
function haversineKm(a: LatLng, b: LatLng) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

async function straightVsRoad(provider: RoutingProvider) {
  const mobile = FLEET.filter((r) => (MOBILE_RESOURCE_TYPES as readonly string[]).includes(r.type));
  const pts = POOL.map(([, lat, lng]) => ({ lat, lng }));
  const m = await provider.table(mobile.map((r) => ({ lat: r.location_lat!, lng: r.location_lng! })), pts);
  const errs: number[] = [];
  const ratios: number[] = [];
  let nearestDiffers = 0;
  let nearestCases = 0;
  const legacyMin = (a: LatLng, b: LatLng) => (haversineKm(a, b) / 25) * 60; // legacy: straight line at 25 km/h
  for (let j = 0; j < pts.length; j++) {
    for (let i = 0; i < mobile.length; i++) {
      const road = m.durations_s[i][j];
      if (road === null) continue;
      const sl = legacyMin({ lat: mobile[i].location_lat!, lng: mobile[i].location_lng! }, pts[j]);
      errs.push(Math.abs(sl - road / 60));
      if (sl > 0.5) ratios.push(road / 60 / sl);
    }
    for (const t of ['ambulance', 'fire_truck', 'police']) {
      const idx = mobile.map((r, i) => [r, i] as const).filter(([r]) => r.type === t);
      const bySl = [...idx].sort((a, b) => legacyMin({ lat: a[0].location_lat!, lng: a[0].location_lng! }, pts[j]) - legacyMin({ lat: b[0].location_lat!, lng: b[0].location_lng! }, pts[j]))[0];
      const byRoad = [...idx].filter(([, i]) => m.durations_s[i][j] !== null).sort((a, b) => m.durations_s[a[1]][j]! - m.durations_s[b[1]][j]!)[0];
      if (bySl && byRoad) { nearestCases++; if (bySl[0].id !== byRoad[0].id) nearestDiffers++; }
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sorted = [...ratios].sort((a, b) => a - b);
  return {
    pairs: errs.length,
    mean_abs_error_min: Math.round(mean(errs) * 10) / 10,
    median_road_to_straight_ratio: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
    nearest_unit_differs_pct: Math.round((1000 * nearestDiffers) / nearestCases) / 10,
    nearest_unit_cases: nearestCases,
  };
}

// ── Reallocation sequences ────────────────────────────────────────────────────
/** Coordinator approves every proposal: moves and replacements close the assignment they replace. */
function applyPlan(commitments: Commitment[], plan: Awaited<ReturnType<typeof optimizer>>, tag: string): Commitment[] {
  const closed = new Set(plan.proposals.map((p) => p.replaces_assignment_id).filter(Boolean));
  return [
    ...commitments.filter((c) => !closed.has(c.assignment_id)),
    ...plan.proposals.map((p, k) => ({ ...commitments[0], assignment_id: `${tag}${k}`, resource_id: p.resource_id, incident_id: p.incident_id })),
  ];
}
async function reallocationSequence(seed: number) {
  const rand = rng(seed);
  const incidents = genIncidents(6, rand, `seq${seed}`);
  const resources = clone(FLEET);
  const blocked = [...SEED_BLOCKED];
  const plan0 = await optimizer(incidents, resources, blocked);
  // Coordinator approves the whole initial plan.
  const commitments: Commitment[] = plan0.proposals.map((p, k) => ({
    assignment_id: `a${seed}-${k}`, resource_id: p.resource_id, incident_id: p.incident_id, status: 'dispatched', eta_minutes: Math.round(p.eta_min), updated_at: '2026-09-27T12:00:00Z',
  }));
  for (const c of commitments) {
    const r = resources.find((x) => x.id === c.resource_id)!;
    r.status = 'dispatched';
    r.assigned_incident_id = c.incident_id;
  }
  const pairsOf = (cs: Commitment[]) => cs.map((c) => ({ resource_id: c.resource_id, incident_id: c.incident_id }));
  const out: Record<string, unknown> = { seed, initial_assignments: commitments.length };

  // (a) the unit on the riskiest incident fails
  const riskiest = [...incidents].sort((a, b) => b.priority_score - a.priority_score)[0];
  const victim = commitments.find((c) => c.incident_id === riskiest.id);
  if (victim) {
    const rs = clone(resources);
    rs.find((r) => r.id === victim.resource_id)!.status = 'unavailable';
    const plan = await optimizer(incidents, rs, blocked, commitments);
    const approved = applyPlan(commitments.filter((c) => c.assignment_id !== victim.assignment_id), plan, 'ra');
    const legacyNoAction = await evaluate(pairsOf(commitments.filter((c) => c.assignment_id !== victim.assignment_id)), incidents, rs, blocked);
    out.unit_failure = {
      optimizer: { replacements: plan.proposals.filter((p) => p.kind === 'replacement').length, moves: plan.stats.moves, ...await evaluate(pairsOf(approved), incidents, rs, blocked) },
      legacy_no_reallocation: legacyNoAction,
    };
  }

  // (b) a road on an active route becomes blocked
  let blockedCase: Record<string, unknown> | null = null;
  for (const c of commitments) {
    const r = resources.find((x) => x.id === c.resource_id)!;
    const inc = incidents.find((i) => i.id === c.incident_id)!;
    const v = await verifiedRoute({ lat: r.location_lat!, lng: r.location_lng! }, { lat: inc.location_lat!, lng: inc.location_lng! }, blocked);
    if (v.status !== 'ok') continue;
    const cs = v.route.coordinates;
    let seg: [number, number][] | null = null;
    for (let i = Math.floor(cs.length * 0.3); i < cs.length - 1; i++) {
      const d = haversineKm({ lat: cs[i][0], lng: cs[i][1] }, { lat: cs[i + 1][0], lng: cs[i + 1][1] }) * 1000;
      if (d >= 150 && d <= 800) { seg = [cs[i], cs[i + 1]]; break; }
    }
    if (!seg) continue;
    const newBlock: BlockedRoadLike = { id: `blk-${seed}`, start_lat: seg[0][0], start_lng: seg[0][1], end_lat: seg[1][0], end_lng: seg[1][1], road_name: 'synthetic block on active route' };
    const bl = [...blocked, newBlock];
    const plan = await optimizer(incidents, resources, bl, commitments);
    const stillOk = !plan.infeasible_commitments.some((x) => x.assignment_id === c.assignment_id);
    const approved = applyPlan(commitments.filter((x) => stillOk || x.assignment_id !== c.assignment_id), plan, 'rb');
    blockedCase = {
      detour_found_for_current_unit: stillOk,
      optimizer: { replacements: plan.proposals.filter((p) => p.kind === 'replacement').length, moves: plan.stats.moves, ...await evaluate(pairsOf(approved), incidents, resources, bl) },
      legacy_no_reallocation: await evaluate(pairsOf(commitments), incidents, resources, bl),
    };
    break;
  }
  out.road_blocked = blockedCase ?? 'no suitable active route segment';

  // (c) a new CRITICAL incident arrives while the fleet is committed
  const [newInc] = genIncidents(1, rng(seed * 97), `new${seed}`);
  newInc.priority = 'critical';
  newInc.priority_score = 100;
  newInc.risk_assessment = { status: 'ok', evidence: { injured: 3, trapped: 2, search_rescue: 1 } };
  const all = [...incidents, newInc];
  const plan = await optimizer(all, resources, blocked, commitments);
  const approved = applyPlan(commitments, plan, 'rc');
  const legacyPicks = recommendResources(legacyIncident(newInc), resources as never, [], blocked as never);
  const legacyPairs = [...pairsOf(commitments), ...legacyPicks.map((p) => ({ resource_id: p.resource_id, incident_id: newInc.id }))];
  out.new_critical_incident = {
    optimizer: { moves: plan.stats.moves, backfills: plan.proposals.filter((p) => p.kind === 'backfill').length, new: plan.proposals.filter((p) => p.kind === 'new').length, mode: plan.mode, ...await evaluate(pairsOf(approved), all, resources, blocked) },
    legacy_top3_for_new_incident: await evaluate(legacyPairs, all, resources, blocked),
  };
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const live = RECORD ? new OsrmProvider((process.env.ROUTING_URL ?? '').replace(/\/+$/, '') || (() => { throw new Error('--record needs ROUTING_URL'); })(), 15_000) : null;
  let fx: Fixture;
  const allPoints: LatLng[] = [
    ...FLEET.filter((r) => r.location_lat != null).map((r) => ({ lat: r.location_lat!, lng: r.location_lng! })),
    ...POOL.map(([, lat, lng]) => ({ lat, lng })),
  ];
  if (RECORD) {
    const keys = [...new Set(allPoints.map(pk))];
    const pts = keys.map((k) => { const [lat, lng] = k.split(',').map(Number); return { lat, lng }; });
    console.log(`recording master matrix for ${pts.length} points from ${live!.id}…`);
    const m = await live!.table(pts, pts);
    fx = {
      note: 'Recorded OSRM road data for the JanRakshak allocation benchmark (replayed deterministically).',
      backend: live!.id, recorded_at: new Date().toISOString(), points: keys, durations_s: m.durations_s, distances_m: m.distances_m, routes: {},
    };
  } else {
    if (!fs.existsSync(FIXTURE)) throw new Error('No routing fixture. Record one: ROUTING_URL=... npx tsx server/scripts/benchmark-allocation.ts --record');
    fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  }
  const provider = new FixtureProvider(fx, live);
  setRoutingProvider(provider);
  clearRoutingCache();

  const results: Record<string, unknown> = {
    disclaimer: 'Synthetic scenario-based evaluation on the Mumbai demo fleet with recorded OSRM road data. Not real-world emergency-response outcomes.',
    fixture: { backend: fx.backend, recorded_at: fx.recorded_at },
    config: ALLOCATION_CONFIG,
  };

  results.straight_line_vs_road = await straightVsRoad(provider);

  // One-shot allocation scenarios.
  type Row = { scenario: string; n: number; seed: number; method: string; runtime_ms: number } & Metrics;
  const rows: Row[] = [];
  const scenarios: { name: string; n: number; scarce: boolean; extraBlocked: boolean }[] = [];
  for (const n of [3, 5, 8, 10, 15]) scenarios.push({ name: 'competing', n, scarce: false, extraBlocked: false });
  for (const n of [5, 10]) scenarios.push({ name: 'scarce (half the fleet out)', n, scarce: true, extraBlocked: false });
  scenarios.push({ name: 'blocked roads', n: 8, scarce: false, extraBlocked: true });
  for (const sc of scenarios) {
    for (const seed of [1, 2, 3, 4]) {
      const rand = rng(seed * 1000 + sc.n + (sc.scarce ? 7 : 0));
      const incidents = genIncidents(sc.n, rand, `${sc.name[0]}${sc.n}s${seed}`);
      const resources = clone(FLEET);
      if (sc.scarce) resources.filter((r) => (MOBILE_RESOURCE_TYPES as readonly string[]).includes(r.type)).forEach((r, i) => { if (i % 2 === 0) r.status = 'unavailable'; });
      const blocked = sc.extraBlocked ? SEED_BLOCKED : [];
      const gi = greedyIndependent(incidents, resources, blocked);
      const gs = greedySequential(incidents, resources, blocked);
      const t = performance.now();
      const plan = await optimizer(incidents, resources, blocked);
      const optMs = performance.now() - t;
      const base = { scenario: sc.name, n: sc.n, seed };
      rows.push({ ...base, method: 'legacy greedy (simultaneous)', runtime_ms: gi.ms, ...await evaluate(gi.pairs, incidents, resources, blocked) });
      rows.push({ ...base, method: 'legacy greedy (sequential)', runtime_ms: gs.ms, ...await evaluate(gs.pairs, incidents, resources, blocked) });
      rows.push({ ...base, method: 'global optimizer', runtime_ms: optMs, solve_ms: plan.stats.solve_ms, ...await evaluate(plan.proposals, incidents, resources, blocked) } as Row);
    }
  }
  results.one_shot = rows;

  // Aggregate by scenario × method.
  const METRIC_KEYS = ['essential_coverage_pct', 'risk_weighted_unmet_essential', 'critical_meeting_target_pct', 'critical_first_unit_eta_min', 'risk_weighted_mean_eta_min', 'capability_mismatches', 'double_bookings', 'blocked_or_infeasible', 'runtime_ms'] as const;
  const agg: Record<string, Record<string, number | null>> = {};
  for (const r of rows) {
    const k = `${r.scenario} | n=${r.n} | ${r.method}`;
    const a = (agg[k] ??= { runs: 0 });
    a.runs = (a.runs as number) + 1;
    for (const m of METRIC_KEYS) {
      const v = r[m];
      if (v === null) continue;
      a[`${m}_sum`] = ((a[`${m}_sum`] as number) ?? 0) + v;
      a[`${m}_n`] = ((a[`${m}_n`] as number) ?? 0) + 1;
    }
  }
  const summary: Record<string, Record<string, number | null>> = {};
  for (const [k, a] of Object.entries(agg)) {
    const s: Record<string, number | null> = { runs: a.runs };
    for (const m of METRIC_KEYS) {
      s[m] = a[`${m}_n`] ? Math.round(((a[`${m}_sum`] as number) / (a[`${m}_n`] as number)) * 100) / 100 : null;
    }
    summary[k] = s;
  }
  results.one_shot_summary = summary;

  const sequences = [];
  for (const seed of [11, 12, 13, 14]) sequences.push(await reallocationSequence(seed));
  results.reallocation_sequences = sequences;

  if (RECORD) {
    fs.writeFileSync(FIXTURE, JSON.stringify(fx));
    console.log(`fixture written: ${Object.keys(fx.routes).length} routes, ${fx.points.length} points`);
  }
  fs.writeFileSync(path.join(BENCH_DIR, 'results.json'), JSON.stringify(results, null, 1));

  // Console report
  console.log('\n=== Straight-line (legacy 25 km/h) vs road ETA ===');
  console.log(results.straight_line_vs_road);
  console.log('\n=== One-shot allocation (mean over 4 seeds) ===');
  const cols = [...METRIC_KEYS];
  console.log(['scenario | n | method', 'essCov%', 'rwUnmetEss', 'CRIT≤8m%', 'CRITeta', 'rwETA', 'capMis', 'dblBook', 'blocked', 'ms'].join('\t'));
  for (const [k, s] of Object.entries(summary)) console.log([k, ...cols.map((c) => s[c] ?? '–')].join('\t'));
  console.log('\n=== Reallocation sequences ===');
  console.log(JSON.stringify(sequences, null, 1));
}

await main();
