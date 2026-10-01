/**
 * Location + deduplication integration tests on an ISOLATED in-memory database, using the real
 * report pipeline and the real HTTP routes (mock geocoder, no Gemini, no network).
 *   npx tsx server/scripts/test-dedup-db.ts
 */
process.env.PGLITE_DATA_DIR = 'memory://dedup-test';
delete process.env.GEMINI_API_KEY;

import http from 'node:http';
import express from 'express';
import { check, section, summary } from './alloc-test-lib.js';
import { MockGeocoder } from './mock-geocoder.js';

const { setGeocoder, resolveLocation } = await import('../src/services/locate.js');
setGeocoder(new MockGeocoder());
const { initDb, closeDb } = await import('../src/db.js');
const reportsMod = await import('../src/routes/reports.js');
const { createReportFromMessage, parseReportBody, reporterFix } = reportsMod;
const incidentRoutes = (await import('../src/routes/incidents.js')).default;
const publicRoutes = (await import('../src/routes/publicReports.js')).default;
const { setReoptimizeEnabled, onReoptimizeRequested } = await import('../src/services/allocation/reoptimize.js');
const { normalizeEvidence } = await import('../src/services/riskAssessment.js');
const { buildPublicView } = await import('../src/services/publicTracking.js');
const { demandSignature } = await import('../src/services/incidentMerge.js');

setReoptimizeEnabled(false);
const triggers: string[] = [];
onReoptimizeRequested((t, d) => triggers.push(`${t}:${d ?? ''}`));

const db = await initDb();
const user = { id: 'u-coord', username: 'coord', full_name: 'Test Coordinator', role: 'coordinator' as const, resource_id: null };
await db.query(`INSERT INTO users (id, username, full_name, password_hash, role) VALUES ($1, 'coord', 'Test Coordinator', 'x', 'coordinator')`, [user.id]);

// Real routes behind a fake login.
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { user: typeof user }).user = user; next(); });
app.use('/api/incidents', incidentRoutes);
app.use('/api/reports', reportsMod.default);
app.use('/api/public/reports', publicRoutes);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() as any };
};

let seq = 0;
function cls(type: string, place: string | null, locality: string | null, evidence: Record<string, number>, text: string) {
  return {
    type, title: `${type} at ${place ?? locality}`, description: text,
    location_name: [place, locality].filter(Boolean).join(', ') || null, location_lat: null, location_lng: null,
    location: { text, place, locality, city: 'Mumbai', state: null, country: 'India' },
    people_affected: Math.max(0, evidence.people_affected ?? 0), injuries: Math.max(0, evidence.injured ?? 0),
    has_children: false, has_elderly: false, has_disabled: false, priority: 'medium', priority_score: 50,
    urgency_indicators: [], evidence: normalizeEvidence(evidence), language: 'en', confidence: 0.9, classifier: 'gemini',
  } as any;
}
async function report(c: any, raw: string, extra: Record<string, unknown> = {}) {
  const fields = parseReportBody({ raw_message: raw, source: 'test', client_id: `client-${++seq}-abcdef`, ...extra });
  const loc = await resolveLocation(c, raw, reporterFix(fields));
  return createReportFromMessage(fields, c, loc, user.id);
}
const incidentCount = async () => (await db.one(`SELECT COUNT(*)::int AS n FROM incidents WHERE parent_incident_id IS NULL`))!.n as number;

section('A/I. Same incident, different wording → merge; evidence changes risk, demand and allocation');
let mallId = '';
{
  const r1 = await report(cls('fire', 'Infiniti Mall', 'Andheri', { fire: 1 }, 'Fire at Infiniti Mall'), 'Fire at Infiniti Mall Andheri');
  mallId = (r1.incident as any).id;
  const before = (await db.one('SELECT * FROM incidents WHERE id = $1', [mallId]))!;
  check(!r1.is_duplicate && before.location_meta?.precision === 'exact' && before.last_report_at, 'first report creates an incident with exact location provenance and last_report_at');
  triggers.length = 0;
  const r2 = await report(cls('fire', 'Infiniti Mall', 'Andheri', { fire: 1, trapped: 3, injured: 4, search_rescue: 1 }, 'Smoke, people trapped at Infiniti mall'), 'Smoke and 3 people trapped at Infiniti Mall, 4 injured');
  const after = (await db.one('SELECT * FROM incidents WHERE id = $1', [mallId]))!;
  check(r2.is_duplicate && (r2.incident as any).id === mallId && (r2 as any).dedup.decision === 'merge', 'second report merged into the canonical incident');
  check(after.corroborating_reports === 2 && after.injuries === 4, 'summary fields updated (corroborating reports, injuries)', { c: after.corroborating_reports, inj: after.injuries });
  check(after.risk_assessment.evidence.trapped === 3 && after.priority_score >= before.priority_score, 'risk re-assessed on merged evidence', { before: before.priority_score, after: after.priority_score });
  check(demandSignature(after) !== demandSignature(before) && demandSignature(after).includes('rescue'), 'demand regenerated: rescue slot + casualty ambulances appear');
  check(triggers.some((t) => t.startsWith('incident_merged')), 're-optimization requested after the merge', triggers);
  const mergedAudit = await db.one(`SELECT details FROM audit_log WHERE action = 'merged' AND incident_id = $1`, [mallId]);
  check(mergedAudit?.details.report_id === (r2 as any).report.id && mergedAudit.details.target_incident_id === mallId, 'explicit merge audit entry with report id and target incident');
  const rep = await db.one('SELECT is_duplicate, dedup, location_meta FROM reports WHERE id = $1', [(r2 as any).report.id]);
  check(rep?.is_duplicate && rep.dedup.decision === 'merge' && rep.location_meta?.precision, 'report stores its dedup decision and location provenance');
}

section('B. Slightly different coordinates (reporter GPS near the mall) → merge');
{
  const r = await report(cls('fire', 'Infiniti Mall', null, { fire: 1 }, 'fire at infiniti mall'), 'Huge fire at Infiniti mall', { reporter_lat: 19.1399, reporter_lng: 72.8310, reporter_accuracy: 20 });
  check(r.is_duplicate && (r.incident as any).id === mallId, 'merged', (r as any).dedup);
}

section('C. A different fire 300 m away → not automatically merged (flagged for review)');
let reviewId = '';
{
  const n0 = await incidentCount();
  const r = await report(cls('fire', 'Laxmi Industrial Estate', 'Andheri', { fire: 1 }, 'godown fire at laxmi industrial estate'),
    'Godown fire at Laxmi Industrial Estate', { reporter_lat: 19.1422, reporter_lng: 72.8305, reporter_accuracy: 15 });
  const inc = (await db.one('SELECT * FROM incidents WHERE id = $1', [(r.incident as any).id]))!;
  reviewId = inc.id;
  check(!r.is_duplicate && (await incidentCount()) === n0 + 1, 'new incident created');
  check(inc.dedup_review?.status === 'pending' && inc.dedup_review.candidates[0].incident_id === mallId, 'flagged as possible duplicate of the mall fire for coordinator review', inc.dedup_review);
  const n = await db.one(`SELECT * FROM notifications WHERE title = 'Possible duplicate incident' AND incident_id = $1`, [inc.id]);
  check(!!n, 'coordinator notified of the possible duplicate');
}

section('D. Same landmark name elsewhere → not merged');
{
  const r1 = await report(cls('fire', 'Sai Baba Mandir', 'Khar', { fire: 1 }, 'fire at sai baba mandir khar'), 'Fire at Sai Baba Mandir Khar');
  const r2 = await report(cls('fire', 'Sai Baba Mandir', 'Dadar', { fire: 1 }, 'fire at sai baba mandir dadar'), 'Fire at Sai Baba Mandir Dadar');
  check(!r2.is_duplicate && (r1.incident as any).id !== (r2.incident as any).id, 'two Sai Baba Mandirs in different areas stay separate incidents', (r2 as any).dedup);
}

section('E. Area-level (mis-placeable) report does not auto-merge');
{
  const r = await report(cls('fire', 'Some Building', 'Andheri', { fire: 1 }, 'fire in some building in andheri'), 'Fire in a building in Andheri');
  const inc = (await db.one('SELECT location_meta FROM incidents WHERE id = $1', [(r.incident as any).id]))!;
  check(!r.is_duplicate && inc.location_meta.precision === 'area', 'area-level report becomes its own incident (at most flagged), never merged', (r as any).dedup);
}

section('F. Recent activity, not creation time, keeps an incident open for merging');
{
  await db.query(`UPDATE incidents SET created_at = now() - interval '5 hours', last_report_at = now() - interval '15 minutes' WHERE id = $1`, [mallId]);
  const r = await report(cls('fire', 'Infiniti Mall', 'Andheri', { fire: 1 }, 'infiniti mall still burning'), 'Infiniti mall still burning');
  check(r.is_duplicate && (r.incident as any).id === mallId, 'created 5 h ago but reported 15 min ago → merged');
  await db.query(`UPDATE incidents SET last_report_at = now() - interval '8 hours' WHERE id = $1`, [mallId]);
  const r2 = await report(cls('fire', 'Infiniti Mall', 'Andheri', { fire: 1 }, 'fire at infiniti mall'), 'Fire at Infiniti mall again');
  check(!r2.is_duplicate, 'no report for 8 h → treated as a new incident');
}

section('G. Simultaneous duplicate reports → one canonical incident');
{
  const n0 = await incidentCount();
  const c = () => cls('building_collapse', 'Gateway of India', 'Colaba', { building_damage: 1, trapped: -1 }, 'wall collapse at gateway of india');
  const [a, b, d] = await Promise.all([
    report(c(), 'Wall collapsed near Gateway of India'),
    report(c(), 'Collapse at gateway of india, people trapped'),
    report(c(), 'Gateway of India wall has fallen'),
  ]);
  const ids = new Set([a, b, d].map((x) => (x.incident as any).id));
  check(ids.size === 1 && (await incidentCount()) === n0 + 1, 'three concurrent reports → exactly one incident', [...ids]);
  const inc = await db.one('SELECT corroborating_reports FROM incidents WHERE id = $1', [[...ids][0]]);
  check(inc?.corroborating_reports === 3, 'all three reports attached to it');
}

section('H. client_id retry → idempotent');
{
  const body = { raw_message: 'Fire in a building at Dadar, 2 people injured', source: 'offline_queue', client_id: 'offline-retry-0001' };
  const first = await api('POST', '/api/reports', body);
  const retry = await api('POST', '/api/reports', body);
  const reports = await db.query(`SELECT id FROM reports WHERE client_id = 'offline-retry-0001'`);
  check(first.status === 201 && retry.status === 200 && retry.body.already_processed === true, 'retry answered 200 already_processed (not a 409 failure)', { first: first.status, retry: retry.status });
  check(retry.body.report.id === first.body.report.id && reports.length === 1, 'same report returned; stored once');
  const c = cls('fire', 'Phoenix Mills', 'Lower Parel', { fire: 1 }, 'fire at phoenix mills');
  const fields = parseReportBody({ raw_message: 'Fire at Phoenix Mills', source: 'test', client_id: 'concurrent-same-0001' });
  const loc = await resolveLocation(c, 'Fire at Phoenix Mills', null);
  const [x, y] = await Promise.all([createReportFromMessage(fields, c, loc, user.id), createReportFromMessage(fields, c, loc, user.id)]);
  const n = await db.query(`SELECT id FROM reports WHERE client_id = 'concurrent-same-0001'`);
  check(n.length === 1 && x.report.id === y.report.id, 'the same client_id submitted concurrently → one report, same answer');
}

section('Public API: unplaceable locations rejected, placeable ones accepted');
{
  const amb = await api('POST', '/api/public/reports', { raw_message: 'Accident on Station Road', client_id: 'public-amb-0001' });
  // Keyword classifier knows no specific place → nothing placeable without GPS.
  check(amb.status === 422 && amb.body.code === 'location_required', 'no usable location → 422 location_required', amb.body);
  const gps = await api('POST', '/api/public/reports', { raw_message: 'Accident on Station Road', client_id: 'public-gps-0001', reporter_lat: 19.2279, reporter_lng: 72.8561, reporter_accuracy: 20 });
  check(gps.status === 201 && gps.body.location.precision === 'exact', 'same report with accurate GPS accepted', gps.body.location);
}

section('Location verification / correction API');
{
  const r = await report(cls('road_accident', 'Station Road', null, { injured: 1 }, 'accident on station road'), 'Accident on Station Road');
  const id = (r.incident as any).id;
  const inc = (await db.one('SELECT * FROM incidents WHERE id = $1', [id]))!;
  check(inc.location_source === 'unverified' && inc.location_meta.ambiguous && inc.location_meta.candidates.length >= 3, 'ambiguous street → unverified with candidates recorded');
  triggers.length = 0;
  const idx = inc.location_meta.candidates.findIndex((c: any) => c.name.includes('Chembur'));
  const pick = await api('PATCH', `/api/incidents/${id}/location`, { action: 'choose_candidate', candidate_index: idx, note: 'caller confirmed Chembur' });
  check(pick.status === 200 && pick.body.location_meta.precision === 'verified' && pick.body.location_source === 'geocoded' && Math.abs(pick.body.location_lat - 19.073) < 0.001, 'coordinator picks the right candidate → verified', pick.body.location_meta?.verified);
  const audit = await db.one(`SELECT details FROM audit_log WHERE action = 'location_corrected' AND incident_id = $1`, [id]);
  check(audit?.details.from && audit.details.to.lat === pick.body.location_lat, 'change audited with from/to');
  check(triggers.some((t) => t.startsWith('incident_location_changed')), 're-optimization requested after the correction');
  const bad = await api('PATCH', `/api/incidents/${id}/location`, { action: 'correct' });
  check(bad.status === 400, 'correct without coordinates → 400');
  // Moving an incident onto another one's location triggers a duplicate re-check (flag, not auto-merge).
  const moved = await api('PATCH', `/api/incidents/${reviewId}/location`, { action: 'correct', lat: 19.1396, lng: 72.8306, location_name: 'Infiniti Mall, Andheri' });
  check(moved.status === 200 && moved.body.dedup_check !== 'new' && moved.body.dedup_review?.status === 'pending', 'correction onto another incident flags a possible duplicate', moved.body.dedup_check);
}

section('Duplicate review: coordinator merges → tracking follows the canonical incident');
{
  const res = await api('POST', `/api/incidents/${reviewId}/duplicate-review`, { decision: 'merge', target_incident_id: mallId });
  const src = (await db.one('SELECT * FROM incidents WHERE id = $1', [reviewId]))!;
  check(res.status === 200 && src.parent_incident_id === mallId && src.status === 'resolved', 'absorbed incident points at the canonical one', { status: res.status, body: res.body.error });
  const moved = await db.query('SELECT id FROM reports WHERE incident_id = $1', [reviewId]);
  check(moved.length === 0, 'its reports moved to the canonical incident');
  const view = await buildPublicView(db, reviewId);
  check(view?.id === mallId, 'citizen tracking the absorbed report now sees the canonical incident');
  const again = await api('POST', `/api/incidents/${mallId}/duplicate-review`, { decision: 'merge', target_incident_id: mallId });
  check(again.status === 400, 'merging an incident into itself is refused');
}

server.close();
await closeDb();
summary('Location + deduplication integration');
