/**
 * Location-resolution tests with a mocked geocoder (no network).
 *   npx tsx server/scripts/test-location.ts
 */
import { check, section, summary } from './alloc-test-lib.js';
import { MockGeocoder } from './mock-geocoder.js';
import { distanceM, resolveLocation, setGeocoder, type ResolveInput } from '../src/services/locate.js';

const geo = new MockGeocoder();
setGeocoder(geo);

const x = (place: string | null, locality: string | null, extra: Partial<ResolveInput> = {}, text?: string): ResolveInput => ({
  location_name: [place, locality].filter(Boolean).join(', ') || null,
  location_lat: null, location_lng: null,
  location: { text: text ?? ([place, locality].filter(Boolean).join(', ') || null), place, locality, city: 'Mumbai', state: null, country: 'India' },
  ...extra,
});
const near = (a: { lat: number; lng: number }, lat: number, lng: number, m: number) => distanceM(a, { lat, lng }) <= m;

section('Gateway of India (famous)');
{
  const r = await resolveLocation(x('Gateway of India', 'Colaba'), 'Fire near Gateway of India', null);
  check(r.meta.precision === 'exact' && r.source === 'geocoded' && near(r, 18.922, 72.8347, 50), 'exact point, labelled geocoded', r.meta);
  check(r.meta.original_text === 'Gateway of India, Colaba' && r.meta.result?.kind === 'point' && r.meta.confidence >= 0.62, 'provenance: original text, result kind, confidence recorded');
}

section('Tilak Nagar Colony, Chembur (uncommon locality; same-ish name elsewhere)');
{
  const r = await resolveLocation(x('Tilak Nagar Colony', 'Chembur'), 'Fire at Tilak Nagar colony Chembur', null);
  check(near(r, 19.0662, 72.8943, 60) && r.meta.precision === 'exact', 'Chembur colony chosen (locality match), not the Mulund "Tilak Nagar" 12 km away', { lat: r.lat, lng: r.lng, p: r.meta.precision });
  check(r.meta.candidates.length >= 2, 'multiple candidates were considered and recorded');
}

section('Sai Baba Mandir, Khar (local landmark with same-name temples)');
{
  const r = await resolveLocation(x('Sai Baba Mandir', 'Khar'), 'Collapse behind Sai Baba mandir near Khar', null);
  check(near(r, 19.0712, 72.8381, 60) && !r.meta.ambiguous, 'Khar temple chosen by locality match, not the Bandra/Dadar temples', { lat: r.lat, lng: r.lng, notes: r.meta.notes });
  const noLoc = await resolveLocation(x('Sai Baba Mandir', null), 'fire at sai baba mandir', null);
  check(noLoc.meta.ambiguous && noLoc.source === 'unverified' && noLoc.meta.needs_verification, 'without a locality: ambiguous → flagged unverified, never silently picked', noLoc.meta.notes);
}

section('Station Road, Mumbai (ambiguous street name)');
{
  const r = await resolveLocation(x('Station Road', null), 'Accident on Station Road', null);
  check(r.meta.ambiguous && r.meta.precision === 'unverified' && r.source === 'unverified', 'many Station Roads → ambiguous, flagged for verification', r.meta.notes);
  const withLoc = await resolveLocation(x('Station Road', 'Chembur'), 'Accident on Station Road Chembur', null);
  check(near(withLoc, 19.073, 72.899, 60) && !withLoc.meta.ambiguous && withLoc.meta.precision !== 'exact', 'with locality: Chembur Station Road chosen; a road is at most approximate', withLoc.meta.precision);
}

section('Sector 5, Mumbai (Navi Mumbai must not pass as Mumbai)');
{
  const r = await resolveLocation(x('Sector 5', null), 'Building 12 Sector 5 flooding', null);
  check(!(r.lng > 72.99) && r.meta.candidates.every((c) => !c.in_scope) && r.meta.needs_verification, 'Navi Mumbai sectors rejected as out of scope; not placed there', { lat: r.lat, lng: r.lng, cands: r.meta.candidates });
  const nm = await resolveLocation({ ...x('Sector 5', 'Vashi'), location: { text: 'Sector 5 Vashi Navi Mumbai', place: 'Sector 5', locality: 'Vashi', city: 'Navi Mumbai', state: null, country: 'India' } }, 'Flooding in Sector 5, Vashi, Navi Mumbai', null);
  check(nm.lng > 72.99, 'explicitly Navi Mumbai → Navi Mumbai candidates allowed', { lat: nm.lat, lng: nm.lng, p: nm.meta.precision });
}

section('Shivaji Nagar, Mumbai (same-name areas)');
{
  const r = await resolveLocation(x('Shivaji Nagar', null), 'Fire at Shivaji Nagar', null);
  check(r.meta.ambiguous && r.source === 'unverified', 'two Shivaji Nagars in Mumbai → ambiguous area, flagged', r.meta.notes);
  const g = await resolveLocation(x('Shivaji Nagar', null), 'Fire at Shivaji Nagar', { lat: 19.0640, lng: 72.9245, accuracy_m: 25 });
  check(g.source === 'reporter_gps' && near(g, 19.064, 72.9245, 5) && !g.meta.needs_verification, 'accurate GPS inside one of them resolves it', g.meta.notes);
}

section('Unknown landmark');
{
  const r = await resolveLocation(x('Big Temple', null, { location_lat: 19.05, location_lng: 72.87 }), 'fire near the big temple', null);
  check(r.meta.precision === 'ai_estimate' && r.source === 'ai_estimate' && r.meta.confidence <= 0.2 && r.meta.needs_verification, 'no match → Gemini estimate used only as a flagged, low-confidence AI estimate', r.meta);
  check(r.meta.gemini_estimate?.lat === 19.05, "Gemini's original estimate preserved in provenance");
  const none = await resolveLocation(x(null, null), 'help fire at my place', null);
  check(none.meta.precision === 'unverified' && none.source === 'unverified' && none.meta.source === 'city_centre', 'nothing usable → unverified placeholder');
}

section('Reporter GPS');
{
  const r = await resolveLocation(x('Dharavi', null), 'fire here in Dharavi', { lat: 19.0402, lng: 72.8581, accuracy_m: 15 });
  check(r.source === 'reporter_gps' && near(r, 19.0402, 72.8581, 1), 'accurate GPS inside the named area beats the area centroid', { src: r.source, p: r.meta.precision });
  const c = await resolveLocation(x('Gateway of India', 'Colaba'), 'fire near gateway of india', { lat: 19.0402, lng: 72.8581, accuracy_m: 15 });
  check(near(c, 18.922, 72.8347, 50) && c.meta.gps_consistency === 'conflict' && c.meta.needs_verification, 'conflicting GPS does not blindly override a strong exact place; conflict flagged', c.meta.notes);
  const weak = await resolveLocation(x('Station Road', null), 'accident on station road', { lat: 19.2279, lng: 72.8561, accuracy_m: 20 });
  check(near(weak, 19.228, 72.856, 60) && !weak.meta.ambiguous && weak.meta.gps_consistency === 'consistent', 'ambiguous text + accurate GPS → the Station Road near the GPS is chosen', { lat: weak.lat, lng: weak.lng, meta: weak.meta.gps_consistency });
  const consistent = await resolveLocation(x('Infiniti Mall', 'Andheri'), 'fire at infiniti mall', { lat: 19.1390, lng: 72.8309, accuracy_m: 30 });
  check(consistent.meta.gps_consistency === 'consistent' && consistent.meta.precision === 'exact' && consistent.meta.confidence > 0.8, 'GPS consistent with an exact place raises confidence', consistent.meta.confidence);
}

section('Area-only fallback');
{
  const r = await resolveLocation(x('Unknown Building', 'Chembur'), 'wall collapse in unknown building chembur', null);
  check(r.meta.precision === 'area' && r.source === 'landmark' && r.name!.includes('area: Chembur'), 'unknown place in a known area → area-level, never labelled exact/geocoded', { p: r.meta.precision, src: r.source, name: r.name });
  check(r.meta.accuracy_m >= 600 && r.meta.needs_verification, 'area-level carries a large accuracy radius and needs verification');
}

section('Geocoder failure');
{
  geo.down = true;
  const r = await resolveLocation(x('Phoenix Mills', 'Lower Parel', { location_lat: 18.99, location_lng: 72.83 }), 'fire at phoenix mills lower parel', null);
  check(!!r.meta.geocoder_error && r.meta.precision === 'area' && r.meta.source === 'gazetteer', 'geocoder down → offline gazetteer gives area level (Lower Parel), error recorded', { p: r.meta.precision, err: r.meta.geocoder_error, src: r.meta.source });
  const g = await resolveLocation(x('Phoenix Mills', null), 'fire at phoenix mills', { lat: 18.995, lng: 72.825, accuracy_m: 20 });
  check(g.source === 'reporter_gps', 'geocoder down + accurate GPS → GPS used');
  geo.down = false;
}

summary('Location resolution');
