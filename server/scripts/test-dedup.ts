/**
 * Duplicate-scoring tests (pure, deterministic).
 *   npx tsx server/scripts/test-dedup.ts
 */
import { check, section, summary } from './alloc-test-lib.js';
import { decideDuplicate, scoreDuplicate, hazardCompatibility, type DedupCandidate, type DedupSignal } from '../src/services/deduplication.js';
import { EMPTY_EVIDENCE, type RiskEvidence } from '../src/services/riskAssessment.js';
import type { LocationMeta } from '../src/services/locate.js';

const now = new Date('2026-09-27T12:00:00Z');
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const ev = (e: Partial<RiskEvidence>): RiskEvidence => ({ ...EMPTY_EVIDENCE, ...e });
const meta = (precision: LocationMeta['precision'], accuracy_m: number, extra: Partial<LocationMeta> = {}): Partial<LocationMeta> => ({ precision, accuracy_m, ambiguous: false, ...extra });
const EXACT = meta('exact', 40);
const AREA = meta('area', 1500);
// ~ metres → degrees near Mumbai
const north = (lat: number, m: number) => lat + m / 111_000;
const east = (lng: number, m: number) => lng + m / (111_000 * Math.cos((19 * Math.PI) / 180));

const BASE = { lat: 19.1395, lng: 72.8305 };
function signal(s: Partial<DedupSignal>): DedupSignal {
  return { type: 'fire', lat: BASE.lat, lng: BASE.lng, location_meta: EXACT, location_source: 'geocoded', place: 'Infiniti Mall', text: 'Fire at Infiniti Mall', evidence: ev({ fire: 1 }), reported_at: now, gps: null, ...s };
}
function cand(c: Partial<DedupCandidate>): DedupCandidate {
  return { id: 'inc-1', type: 'fire', lat: BASE.lat, lng: BASE.lng, location_meta: EXACT, location_source: 'geocoded', place: 'Infiniti Mall', texts: ['Fire at Infiniti Mall, smoke visible'], evidence: ev({ fire: 1 }), last_activity: minsAgo(10), gps: [], ...c };
}

section('A. Same incident, different wording → merge');
{
  const s = signal({ text: 'Smoke and people trapped at Infiniti Mall, please send rescue', evidence: ev({ fire: 1, trapped: -1, search_rescue: 1 }) });
  const r = scoreDuplicate(s, cand({}));
  check(r.decision === 'merge', `merged (score ${r.score})`, r);
}

section('B. Same incident, slightly different coordinates → merge when confidence supports it');
{
  const s = signal({ lat: north(BASE.lat, 60), lng: east(BASE.lng, 50), text: 'Big fire at infiniti mall andheri' });
  const r = scoreDuplicate(s, cand({}));
  check(r.decision === 'merge', `~80 m apart, same place, precise locations → merge (score ${r.score})`, r);
  const low = scoreDuplicate({ ...s, location_meta: AREA, location_source: 'landmark' }, cand({}));
  check(low.decision !== 'merge', `same situation but one location is area-level → not auto-merged (${low.decision})`, low.reasons);
}

section('C. Two separate fires 300 m apart → NOT automatically merged');
{
  const s = signal({ lat: north(BASE.lat, 300), place: 'Laxmi Industrial Estate', text: 'Fire in a godown at Laxmi Industrial Estate' });
  const r = scoreDuplicate(s, cand({}));
  check(r.decision !== 'merge', `different named places 300 m apart → ${r.decision} (score ${r.score})`, r.reasons);
}

section('D. Same landmark name in different locations → NOT merged');
{
  const s = signal({ lat: 19.0712, lng: 72.8381, place: 'Sai Baba Mandir', text: 'Fire near Sai Baba Mandir' });
  const r = scoreDuplicate(s, cand({ lat: 19.018, lng: 72.844, place: 'Sai Baba Mandir', texts: ['Fire at Sai Baba Mandir'] }));
  check(r.decision === 'new' && r.veto === 'same_name_different_place', `5.9 km apart with the same name → vetoed`, r);
  const near2k = scoreDuplicate(signal({ place: 'Station Road', text: 'accident on station road' , type: 'road_accident', evidence: ev({ injured: 2 }) }),
    cand({ type: 'road_accident', lat: north(BASE.lat, 2000), place: 'Station Road', texts: ['accident on station road'], evidence: ev({ injured: 2 }) }));
  check(near2k.decision === 'new' && near2k.veto === 'same_name_different_place', 'same name 2 km apart (inside the distance limit) → still vetoed', near2k);
}

section('E. Mis-geocoded report does not corrupt deduplication');
{
  // A report that could only be placed at an area centroid ~1.5 km off.
  const s = signal({ lat: 19.1197, lng: 72.8464, location_meta: AREA, location_source: 'landmark', place: 'Andheri', text: 'fire somewhere in andheri' });
  const r = scoreDuplicate(s, cand({}));
  check(r.decision !== 'merge', `area-level report is never auto-merged (${r.decision}, ${r.score})`, r.reasons);
  // Two unrelated incidents that both fell back to the same area centroid.
  const a = signal({ lat: 19.1197, lng: 72.8464, location_meta: AREA, location_source: 'landmark', place: 'Andheri', text: 'shop fire andheri east' });
  const b = cand({ lat: 19.1197, lng: 72.8464, location_meta: AREA, location_source: 'landmark', place: 'Andheri', texts: ['kitchen fire in a flat, andheri west'] });
  const same = scoreDuplicate(a, b);
  check(same.decision !== 'merge', `identical area-centroid coordinates alone never merge (${same.decision})`, same.reasons);
}

section('F. Same incident after a long interval → based on recent activity');
{
  // Incident created 5 h ago but a report arrived 20 min ago → still active → merge.
  const recent = scoreDuplicate(signal({}), cand({ last_activity: minsAgo(20) }));
  check(recent.decision === 'merge', `last report 20 min ago → merge (${recent.score})`);
  const stale = scoreDuplicate(signal({}), cand({ last_activity: minsAgo(7 * 60) }));
  check(stale.decision === 'new' && stale.veto === 'stale', 'no report for 7 h → new incident');
}

section('Hazard compatibility');
{
  check(hazardCompatibility('fire', 'gas_leak', ev({ fire: 1 }), ev({})) >= 0.8, 'fire ~ gas leak (fire evidence)');
  check(hazardCompatibility('fire', 'building_collapse', ev({ fire: 1, building_damage: 1 }), ev({})) >= 0.8, 'fire ~ collapse when fire + structural damage evidence');
  check(hazardCompatibility('flood', 'fire', ev({}), ev({})) === 0, 'flood vs fire incompatible');
  const r = scoreDuplicate(signal({ type: 'gas_leak', text: 'gas leak and fire at Infiniti Mall', evidence: ev({ fire: 1 }) }), cand({}));
  check(r.decision === 'merge', `gas leak report at the burning mall merges into the fire (score ${r.score})`, r);
  const bad = scoreDuplicate(signal({ type: 'flood' }), cand({}));
  check(bad.decision === 'new' && bad.veto === 'incompatible_hazard', 'flood report never merges into a fire');
}

section('Best candidate, not first');
{
  const far = cand({ id: 'far', lat: north(BASE.lat, 400), place: 'Laxmi Industrial Estate', texts: ['godown fire'] });
  const exact = cand({ id: 'exact' });
  const d = decideDuplicate(signal({}), [far, exact]);
  check(d.decision === 'merge' && d.target?.incident_id === 'exact', 'every candidate scored; the best one (not the first) is chosen', d.scores.map((x) => [x.incident_id, x.score]));
  const twin = cand({ id: 'twin', lat: north(BASE.lat, 20) });
  const d2 = decideDuplicate(signal({}), [exact, twin]);
  check(d2.decision === 'review', 'two near-equal merge targets → coordinator review', d2.scores.map((x) => [x.incident_id, x.score]));
}

section('Reporter GPS consistency');
{
  const s = signal({ gps: { lat: north(BASE.lat, 30), lng: BASE.lng }, text: 'fire at mall' });
  const withGps = scoreDuplicate(s, cand({ gps: [{ lat: BASE.lat, lng: BASE.lng }] }));
  const conflict = scoreDuplicate(s, cand({ gps: [{ lat: north(BASE.lat, 5000), lng: BASE.lng }] }));
  check(withGps.score > conflict.score, `reporters standing together raise the score (${withGps.score} vs ${conflict.score})`);
}

summary('Deduplication scoring');
