/**
 * Database-level allocation tests on an ISOLATED in-memory database (the real data is untouched):
 * persistence, approval race, stale plans, unique-index backstop, replacement & move approval,
 * rejection cooldown, capacity updates, degraded routing.
 *   npx tsx server/scripts/test-allocation-db.ts
 */
process.env.PGLITE_DATA_DIR = 'memory://alloc-test';

import { check, section, summary } from './alloc-test-lib.js';
import { MockRoutingProvider, loadRoutingModule } from './mock-routing.js';

const routing = await loadRoutingModule();
const mock = new MockRoutingProvider();
routing.setRoutingProvider(mock);

const { initDb, closeDb } = await import('../src/db.js');
const { runOptimization } = await import('../src/services/allocation/allocationRun.js');
const { transitionAssignment, transitionIncident } = await import('../src/services/workflow.js');
const { ChangeSet } = await import('../src/rows.js');
const { setReoptimizeEnabled } = await import('../src/services/allocation/reoptimize.js');
setReoptimizeEnabled(false);

const db = await initDb();
const user = { id: 'u-coord', username: 'coord', full_name: 'Test Coordinator', role: 'coordinator' as const, resource_id: null };
await db.query(`INSERT INTO users (id, username, full_name, password_hash, role) VALUES ($1, 'coord', 'Test Coordinator', 'x', 'coordinator')`, [user.id]);

const at = (a: number, b: number) => ({ lat: 19 + a / 111, lng: 72.85 + b / 111 });
async function resource(id: string, type: string, p: { lat: number; lng: number }, caps: string[], extra: Record<string, unknown> = {}) {
  const r = { capacity: type === 'ambulance' ? 2 : type === 'hospital' ? 300 : 1, current_load: 0, status: 'available', ...extra };
  await db.query(
    `INSERT INTO resources (id, type, name, location_lat, location_lng, status, capacity, current_load, capabilities)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, type, id, p.lat, p.lng, r.status, r.capacity, r.current_load, JSON.stringify(caps)],
  );
}
async function incident(id: string, type: string, priority: string, score: number, p: { lat: number; lng: number }, evidence: Record<string, number> = {}) {
  await db.query(
    `INSERT INTO incidents (id, type, status, priority, priority_score, title, location_lat, location_lng, risk_assessment)
     VALUES ($1, $2, 'triage', $3, $4, $5, $6, $7, $8)`,
    [id, type, priority, score, id, p.lat, p.lng, JSON.stringify({ status: 'ok', evidence })],
  );
}
const approve = async (id: string, force = false) => {
  const changes = new ChangeSet();
  await db.transaction((tx) => transitionAssignment(tx, id, 'dispatched', user, changes, { force }));
};
const setStatus = async (id: string, to: 'en_route' | 'arrived' | 'completed' | 'rejected') => {
  const changes = new ChangeSet();
  await db.transaction((tx) => transitionAssignment(tx, id, to, user, changes));
};
const errOf = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null; } catch (e) { return e as { status?: number; code?: string; message: string }; }
};
const proposals = () => db.query(`SELECT * FROM resource_assignments WHERE status = 'recommended' AND allocation IS NOT NULL ORDER BY id`);
const row = (id: string) => db.one('SELECT * FROM resource_assignments WHERE id = $1', [id]);
const resRow = (id: string) => db.one('SELECT * FROM resources WHERE id = $1', [id]);

// World: a hospital, two fire trucks, two ambulances, a police unit; one HIGH fire.
await resource('H1', 'hospital', at(0, 3), ['emergency', 'trauma', 'burn_unit']);
await resource('FT1', 'fire_truck', at(0, 1), ['fire_suppression', 'rescue']);
await resource('FT2', 'fire_truck', at(0, 4), ['fire_suppression', 'rescue']);
await resource('AMB1', 'ambulance', at(1, 0), ['basic_life_support']);
await resource('AMB2', 'ambulance', at(5, 5), ['basic_life_support']);
await resource('POL1', 'police', at(1, 1), ['evacuation']);
await incident('FIRE-A', 'fire', 'high', 75, at(0, 0), { injured: 2, fire: 1 });

section('Migration 4');
{
  const idx = await db.one(`SELECT indexdef FROM pg_indexes WHERE indexname = 'resource_one_active_assignment'`);
  check(idx && /WHERE/.test(idx.indexdef), 'partial unique index resource_one_active_assignment exists', idx);
  const col = await db.one(`SELECT data_type FROM information_schema.columns WHERE table_name = 'resource_assignments' AND column_name = 'allocation'`);
  check(col?.data_type === 'jsonb', 'resource_assignments.allocation JSONB column exists');
}

section('Persistence into existing recommendation rows');
let firstIds: string[] = [];
{
  const { plan } = await runOptimization(db, { trigger: 'test' });
  const rows = await proposals();
  firstIds = rows.map((r) => r.id);
  check(!plan.degraded && rows.length === plan.proposals.length && rows.length >= 3, `plan persisted as ${rows.length} 'recommended' rows`, plan.proposals.map((p) => p.key));
  check(rows.every((r) => r.allocation?.run_id === plan.run_id && r.allocation.slot && r.allocation.utility && r.allocation.eta.source === mock.id), 'each row carries allocation metadata (run, slot, utility, ETA source)');
  const again = await runOptimization(db, { trigger: 'test-again' });
  const rows2 = await proposals();
  check(rows2.map((r) => r.id).join() === firstIds.join() && rows2.every((r) => r.allocation.run_id === again.plan.run_id), 'unchanged plan keeps the same rows (no churn, no duplicates), metadata refreshed');
  const audits = await db.query(`SELECT * FROM audit_log WHERE action = 'allocation_run'`);
  check(audits.length === 2 && audits[0].details.stats, 'every run is audited with its stats');
}

section('Approval race: unit taken by another assignment first');
{
  const amb = (await proposals()).find((r) => r.resource_id === 'AMB1')!;
  check(!!amb, 'precondition: AMB1 proposed for FIRE-A');
  await incident('OTHER-C', 'road_accident', 'medium', 50, at(2, 0));
  await db.query(`INSERT INTO resource_assignments (id, incident_id, resource_id, status) VALUES ('manual-C', 'OTHER-C', 'AMB1', 'recommended')`);
  await approve('manual-C'); // manual dispatch of AMB1 elsewhere wins the race
  const e1 = await errOf(() => approve(amb.id));
  const e2 = await errOf(() => approve(amb.id, true));
  check(e1?.status === 409 && e1.code === 'allocation_conflict', 'approving the stale proposal fails with 409 allocation_conflict', e1);
  check(e2?.status === 409 && e2.code === 'allocation_conflict', '…even when forced (it would steal the unit from a different incident)', e2);
  check((await row(amb.id))?.status === 'recommended', 'stale proposal left untouched');
  const e3 = await errOf(() => db.query(`INSERT INTO resource_assignments (id, incident_id, resource_id, status) VALUES ('dup', 'FIRE-A', 'AMB1', 'dispatched')`));
  check(e3?.code === '23505', 'database backstop: a second active assignment for the same unit is rejected (23505)', e3?.code);
  await setStatus('manual-C', 'rejected'); // free AMB1 again
}

section('Stale plan: road blockages changed');
{
  await runOptimization(db, { trigger: 'test' });
  const p = (await proposals()).find((r) => r.resource_id === 'POL1')!;
  await db.query(`INSERT INTO blocked_roads (id, start_lat, start_lng, end_lat, end_lng, road_name) VALUES ('BR-X', 18.5, 72.5, 18.51, 72.51, 'Far away')`);
  const e = await errOf(() => approve(p.id));
  check(e?.status === 409 && e.code === 'allocation_stale', 'approval refused when blocked roads changed after the plan', e);
  await runOptimization(db, { trigger: 'road_blocked' });
  const fresh = (await proposals()).find((r) => r.resource_id === 'POL1')!;
  const e2 = await errOf(() => approve(fresh.id));
  check(!e2 && (await resRow('POL1'))?.status === 'dispatched', 'refreshed proposal approves and dispatches through the existing workflow', e2);
}

section('Capacity: ambulance transport');
{
  const amb = (await proposals()).find((r) => r.resource_id === 'AMB1' && r.allocation.slot.capacity_need > 0)!;
  check(!!amb && amb.allocation.destination?.id === 'H1', 'casualty slot carries a destination hospital', amb?.allocation?.destination);
  const need = amb.allocation.slot.capacity_need;
  const h0 = (await resRow('H1'))!.current_load;
  await approve(amb.id);
  await setStatus(amb.id, 'en_route');
  await setStatus(amb.id, 'arrived');
  check((await resRow('AMB1'))!.current_load === need, `arrived → ambulance load = ${need} patients`);
  await setStatus(amb.id, 'completed');
  check((await resRow('AMB1'))!.current_load === 0 && (await resRow('H1'))!.current_load === h0 + need, 'completed → patients handed over to the destination hospital');
}

section('Replacement when a dispatched unit becomes unavailable');
{
  await runOptimization(db, { trigger: 'test' });
  const ft = (await proposals()).find((r) => r.resource_id === 'FT1')!;
  await approve(ft.id);
  await db.query(`UPDATE resources SET status = 'unavailable' WHERE id = 'FT1'`);
  const { plan } = await runOptimization(db, { trigger: 'resource_unavailable' });
  check(plan.infeasible_commitments.some((c) => c.assignment_id === ft.id), 'optimizer flags the unavailable unit’s assignment as infeasible');
  check((await row(ft.id))?.status === 'dispatched', 'the original assignment is NOT cancelled automatically');
  const rep = (await proposals()).find((r) => r.allocation.kind === 'replacement');
  check(rep?.resource_id === 'FT2' && rep.allocation.replaces_assignment_id === ft.id, 'replacement proposal (FT2) linked to the replaced assignment');
  await approve(rep!.id);
  const old = await row(ft.id);
  check(old?.status === 'rejected' && old.coordinator_action === 'replaced', 'approving the replacement closes the old assignment in the same transaction');
  check((await resRow('FT1'))?.status === 'unavailable' && (await resRow('FT2'))?.status === 'dispatched', 'unavailable unit stays unavailable; replacement dispatched');
  const audit = await db.one(`SELECT * FROM audit_log WHERE action = 'replaced' AND entity_id = $1`, [ft.id]);
  check(!!audit, 'replacement decision audited');
}

section('Move of a committed unit needs the existing force confirmation');
{
  await db.query(`UPDATE resources SET status = 'available' WHERE id = 'FT1'`);
  await incident('COLLAPSE-CRIT', 'building_collapse', 'critical', 100, at(0, 5), { trapped: 5, search_rescue: 1 });
  // Make FT1 the only candidate so the critical incident must pull FT2 or use FT1.
  await db.query(`UPDATE resources SET status = 'unavailable' WHERE id = 'FT1'`);
  const { plan } = await runOptimization(db, { trigger: 'incident_created' });
  const mv = (await proposals()).find((r) => r.allocation.kind === 'move' && r.resource_id === 'FT2');
  check(plan.mode === 'with_moves' && mv?.resource_id === 'FT2' && mv.incident_id === 'COLLAPSE-CRIT', 'CRITICAL collapse → move of FT2 proposed', { mode: plan.mode, props: plan.proposals.map((p) => [p.kind, p.resource_name, p.incident_id]) });
  if (mv) {
    const e = await errOf(() => approve(mv.id));
    check(e?.code === 'resource_busy', 'approving a move first asks for the existing "reassign anyway?" confirmation', e);
    await approve(mv.id, true);
    const prev = await row(mv.allocation.replaces_assignment_id);
    check(prev?.status === 'rejected' && prev.coordinator_action === 'reassigned', 'forced approval closes the previous assignment (reassigned)');
    check((await db.query(`SELECT id FROM resource_assignments WHERE resource_id = 'FT2' AND status IN ('dispatched','en_route','arrived')`)).length === 1, 'FT2 has exactly one active assignment');
  }
}

section('Rejection cooldown');
{
  await db.query(`UPDATE resources SET status = 'available' WHERE id = 'FT1'`);
  await runOptimization(db, { trigger: 'resource_available' });
  const p = (await proposals()).find((r) => r.resource_id === 'FT1')!;
  check(!!p, 'precondition: FT1 proposed');
  await setStatus(p.id, 'rejected');
  await runOptimization(db, { trigger: 'coordinator_decision' });
  check(!(await proposals()).some((r) => r.resource_id === 'FT1' && r.incident_id === p.incident_id), 'rejected pair not re-proposed during cooldown');
  await db.query(`UPDATE resource_assignments SET updated_at = now() - interval '1 day' WHERE id = $1`, [p.id]);
  await runOptimization(db, { trigger: 'cooldown_elapsed' });
  check((await proposals()).some((r) => r.resource_id === 'FT1' && r.incident_id === p.incident_id), 'after the cooldown the pair may be proposed again');
}

section('Resolving an incident keeps unavailable units unavailable');
{
  const active = await db.one(`SELECT * FROM resource_assignments WHERE resource_id = 'FT2' AND status IN ('dispatched','en_route')`);
  await db.query(`UPDATE resources SET status = 'unavailable' WHERE id = 'FT2'`);
  const changes = new ChangeSet();
  await db.transaction((tx) => transitionIncident(tx, active!.incident_id, 'resolved', user, changes));
  check((await resRow('FT2'))?.status === 'unavailable' && (await resRow('FT2'))?.assigned_incident_id === null, 'unit freed from the incident but still unavailable');
}

section('Degraded routing');
{
  const before = (await proposals()).map((r) => r.id).join();
  mock.down = true;
  routing.clearRoutingCache();
  const { plan } = await runOptimization(db, { trigger: 'test-degraded' });
  mock.down = false;
  check(plan.degraded, 'routing down → run marked DEGRADED');
  check((await proposals()).map((r) => r.id).join() === before, 'existing proposals untouched; no straight-line proposals written');
  const a = await db.one(`SELECT details FROM audit_log WHERE action = 'allocation_run' AND details->>'trigger' = 'test-degraded'`);
  check(a?.details.degraded === true && a.details.degraded_reason, 'degraded state is recorded in the audit log');
  const n = await db.one(`SELECT * FROM notifications WHERE title LIKE 'Allocation degraded%'`);
  check(!!n, 'coordinator notified that allocation is degraded');
}

await closeDb();
summary('Allocation database tests');
