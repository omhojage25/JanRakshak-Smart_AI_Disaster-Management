/**
 * Location resolution: report text + Gemini's structured location + reporter GPS → one incident
 * location with explicit precision, confidence and provenance.
 *
 *  - The geocoder returns SEVERAL candidates; each is scored on name similarity, locality match,
 *    Mumbai scope, result type, reporter-GPS proximity and (weakly) Gemini's estimate.
 *  - Area-level results are always labelled area-level, never "exact".
 *  - Gemini coordinates are a hint, never ground truth: used alone only as a flagged "ai_estimate".
 *  - Fresh reporter GPS is a strong signal, reconciled against the text rather than blindly winning.
 *
 * incidents.location_source keeps its existing values (UI compatibility); the full picture is in
 * incidents.location_meta (LocationMeta below).
 */

export type LocationSource = 'geocoded' | 'ai_estimate' | 'reporter_gps' | 'landmark' | 'unverified';
/** exact = strongly resolved point · approximate = street/weak match · area = locality centroid. */
export type LocationPrecision = 'verified' | 'exact' | 'approximate' | 'area' | 'ai_estimate' | 'unverified';

export interface StructuredLocation {
  text: string | null;
  place: string | null;
  locality: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface GeoCandidate {
  lat: number;
  lng: number;
  name: string;
  display_name: string;
  category: string;
  type: string;
  addresstype: string;
  importance: number;
  address: Record<string, string>;
  /** [south, north, west, east] */
  bbox: [number, number, number, number] | null;
}

export interface Geocoder {
  readonly id: string;
  search(query: string): Promise<GeoCandidate[]>;
}

export interface CandidateSummary {
  name: string;
  lat: number;
  lng: number;
  kind: 'point' | 'road' | 'area';
  score: number;
  in_scope: boolean;
  reason?: string;
}

export interface LocationMeta {
  version: 1;
  precision: LocationPrecision;
  confidence: number;
  accuracy_m: number;
  source: 'geocoder' | 'reporter_gps' | 'gazetteer' | 'ai_estimate' | 'city_centre' | 'coordinator';
  original_text: string | null;
  structured: StructuredLocation;
  matched_query: string | null;
  result: { name: string; category: string; type: string; kind: 'point' | 'road' | 'area' } | null;
  ambiguous: boolean;
  candidates: CandidateSummary[];
  gemini_estimate: { lat: number; lng: number } | null;
  reporter_gps: { lat: number; lng: number; accuracy_m: number | null } | null;
  gps_consistency: 'consistent' | 'conflict' | 'used' | 'not_available';
  needs_verification: boolean;
  notes: string[];
  geocoder: string | null;
  geocoder_error: string | null;
  verified?: { by: string; at: string; action: string };
}

export interface ResolvedLocation {
  lat: number;
  lng: number;
  name: string | null;
  source: LocationSource;
  meta: LocationMeta;
}

// ── Mumbai scope ──────────────────────────────────────────────────────────────
/** Area geocoder requests are restricted to (Mumbai Metropolitan Region, so explicit Thane/Navi Mumbai reports still work). */
const SEARCH_BOX = { south: 18.85, north: 19.35, west: 72.75, east: 73.15 };
/** Greater Mumbai (MCGM) approximation; used when a candidate has no usable address fields. */
const GREATER_MUMBAI = { south: 18.89, north: 19.275, west: 72.77, east: 72.985 };
const CITY_CENTRE = { lat: 19.076, lng: 72.8777 };
const NEIGHBOUR_CITIES: { city: string; aliases: string[] }[] = [
  { city: 'Navi Mumbai', aliases: ['navi mumbai', 'नवी मुंबई', 'vashi', 'वाशी', 'nerul', 'belapur', 'kharghar', 'airoli', 'panvel', 'sanpada', 'ghansoli'] },
  { city: 'Thane', aliases: ['thane', 'ठाणे'] },
  { city: 'Mira-Bhayandar', aliases: ['mira road', 'bhayandar', 'mira-bhayandar'] },
];
const MUMBAI_DISTRICTS = ['mumbai suburban', 'mumbai city', 'mumbai'];

const inBox = (b: typeof GREATER_MUMBAI, lat: number, lng: number) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;

/** Which cities the report allows: Greater Mumbai always; a neighbouring city only when the report names it. */
export function allowedCities(message: string, structured: StructuredLocation): Set<string> {
  const text = `${message} ${structured.city ?? ''} ${structured.locality ?? ''}`.toLowerCase();
  const out = new Set(['Mumbai']);
  for (const n of NEIGHBOUR_CITIES) if (n.aliases.some((a) => text.includes(a))) out.add(n.city);
  return out;
}

export function candidateCity(c: GeoCandidate): string | null {
  const a = c.address ?? {};
  const city = (a.city ?? a.town ?? a.municipality ?? '').toLowerCase();
  const district = (a.state_district ?? a.county ?? '').toLowerCase();
  if (city.includes('navi mumbai')) return 'Navi Mumbai';
  if (city.includes('mira') || city.includes('bhayandar')) return 'Mira-Bhayandar';
  if (city === 'thane' || (district === 'thane' && !city)) return 'Thane';
  if (city === 'mumbai' || MUMBAI_DISTRICTS.includes(district)) return 'Mumbai';
  if (city) return city.replace(/\b\w/g, (m) => m.toUpperCase());
  return inBox(GREATER_MUMBAI, c.lat, c.lng) ? 'Mumbai' : null;
}

// ── Text similarity ───────────────────────────────────────────────────────────
const STOP = new Set(['the', 'of', 'near', 'at', 'in', 'on', 'and', 'road', 'rd', 'marg', 'mumbai', 'india', 'maharashtra', 'west', 'east', 'w', 'e']);
const SYNONYMS: Record<string, string> = { temple: 'mandir', masjid: 'mosque', stn: 'station', hosp: 'hospital', bldg: 'building', chowk: 'junction', nagar: 'nagar' };

export function tokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .map((t) => SYNONYMS[t] ?? t).filter((t) => t.length > 1 && !STOP.has(t));
}

/** Share of the query's tokens found in the candidate text (0..1). */
export function containment(query: string | null, candidate: string | null): number {
  const q = tokens(query);
  if (!q.length) return 0;
  const c = new Set(tokens(candidate));
  return q.filter((t) => c.has(t)).length / q.length;
}

// ── Candidate classification ──────────────────────────────────────────────────
const AREA_TYPES = new Set(['suburb', 'neighbourhood', 'quarter', 'city_district', 'residential', 'village', 'hamlet', 'locality', 'city', 'town', 'county', 'state_district', 'borough', 'district', 'isolated_dwelling', 'municipality']);
const POINT_CATEGORIES = new Set(['amenity', 'building', 'tourism', 'historic', 'shop', 'office', 'leisure', 'railway', 'aeroway', 'man_made', 'craft', 'emergency', 'healthcare', 'public_transport']);
function kindOf(c: GeoCandidate): 'point' | 'road' | 'area' {
  if (c.category === 'highway') return 'road';
  if (POINT_CATEGORIES.has(c.category)) return 'point';
  if (AREA_TYPES.has(c.addresstype) || AREA_TYPES.has(c.type) || c.category === 'boundary' || c.category === 'landuse' || (c.category === 'place' && c.type !== 'house')) return 'area';
  return 'point';
}

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
export { distanceM };

function accuracyOf(c: GeoCandidate, kind: 'point' | 'road' | 'area'): number {
  if (c.bbox) {
    const diag = distanceM({ lat: c.bbox[0], lng: c.bbox[2] }, { lat: c.bbox[1], lng: c.bbox[3] }) / 2;
    if (kind === 'point') return Math.min(250, Math.max(30, diag));
    if (kind === 'road') return Math.min(1500, Math.max(150, diag));
    return Math.min(5000, Math.max(600, diag));
  }
  return kind === 'point' ? 60 : kind === 'road' ? 600 : 1500;
}

// ── Geocoder (Nominatim) ──────────────────────────────────────────────────────
export class NominatimGeocoder implements Geocoder {
  readonly id = 'nominatim';
  private cache = new Map<string, GeoCandidate[]>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;

  search(query: string): Promise<GeoCandidate[]> {
    const key = query.toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    // Usage policy: ≤ 1 request/second, identifying User-Agent, cached results.
    const run = this.queue.then(async () => {
      const wait = this.lastCall + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      const params = new URLSearchParams({
        q: query, format: 'jsonv2', limit: '8', addressdetails: '1', countrycodes: 'in', bounded: '1',
        viewbox: `${SEARCH_BOX.west},${SEARCH_BOX.north},${SEARCH_BOX.east},${SEARCH_BOX.south}`,
      });
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { 'User-Agent': 'JanRakshak/1.0 (disaster response coordination)', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      const rows = await res.json() as Record<string, any>[];
      const out: GeoCandidate[] = rows.map((r) => ({
        lat: Number(r.lat), lng: Number(r.lon), name: r.name || String(r.display_name ?? '').split(',')[0],
        display_name: r.display_name ?? '', category: r.category ?? r.class ?? '', type: r.type ?? '',
        addresstype: r.addresstype ?? '', importance: Number(r.importance ?? 0), address: r.address ?? {},
        bbox: Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) as [number, number, number, number] : null,
      }));
      this.cache.set(key, out);
      if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

let geocoder: Geocoder = new NominatimGeocoder();
/** Tests inject a deterministic geocoder. */
export function setGeocoder(g: Geocoder) { geocoder = g; }

// ── Offline gazetteer (area centroids; used only as area-level fallback) ───────
const LANDMARKS: { name: string; lat: number; lng: number; aliases: string[] }[] = [
  { name: 'Colaba', lat: 18.9067, lng: 72.8147, aliases: ['colaba', 'कुलाबा'] },
  { name: 'Gateway of India', lat: 18.922, lng: 72.8347, aliases: ['gateway of india'] },
  { name: 'CSMT', lat: 18.9398, lng: 72.8354, aliases: ['csmt', 'cst', 'victoria terminus', 'सीएसटी'] },
  { name: 'Churchgate', lat: 18.9322, lng: 72.8264, aliases: ['churchgate', 'चर्चगेट'] },
  { name: 'Fort', lat: 18.9338, lng: 72.8356, aliases: ['fort area'] },
  { name: 'Marine Drive', lat: 18.944, lng: 72.823, aliases: ['marine drive', 'मरीन ड्राइव'] },
  { name: 'Grant Road', lat: 18.9633, lng: 72.8158, aliases: ['grant road', 'ग्रांट रोड'] },
  { name: 'Bhendi Bazaar', lat: 18.9579, lng: 72.8318, aliases: ['bhendi bazaar', 'bhendi bazar', 'भेंडी बाजार'] },
  { name: 'Byculla', lat: 18.979, lng: 72.833, aliases: ['byculla', 'भायखळा', 'भायखला'] },
  { name: 'Mumbai Central', lat: 18.969, lng: 72.8196, aliases: ['mumbai central', 'मुंबई सेंट्रल'] },
  { name: 'Worli', lat: 19.0096, lng: 72.8153, aliases: ['worli', 'वरळी', 'वर्ली'] },
  { name: 'Lower Parel', lat: 18.996, lng: 72.83, aliases: ['lower parel', 'लोअर परळ', 'लोअर परेल'] },
  { name: 'Parel', lat: 19.003, lng: 72.841, aliases: ['parel', 'परळ', 'परेल'] },
  { name: 'Wadala', lat: 19.017, lng: 72.865, aliases: ['wadala', 'वडाळा', 'वडाला'] },
  { name: 'Dadar', lat: 19.0178, lng: 72.8478, aliases: ['dadar', 'दादर'] },
  { name: 'Matunga', lat: 19.027, lng: 72.855, aliases: ['matunga', 'माटुंगा'] },
  { name: 'Sion', lat: 19.04, lng: 72.862, aliases: ['sion', 'सायन', 'शीव'] },
  { name: 'Mahim', lat: 19.035, lng: 72.84, aliases: ['mahim', 'माहिम', 'माहीम'] },
  { name: 'Dharavi', lat: 19.043, lng: 72.8527, aliases: ['dharavi', 'धारावी'] },
  { name: 'Bandra Kurla Complex', lat: 19.066, lng: 72.868, aliases: ['bandra kurla complex', 'bkc'] },
  { name: 'Bandra', lat: 19.0596, lng: 72.8295, aliases: ['bandra', 'बांद्रा', 'वांद्रे'] },
  { name: 'Khar', lat: 19.0703, lng: 72.8376, aliases: ['khar', 'खार'] },
  { name: 'Kurla', lat: 19.0726, lng: 72.8794, aliases: ['kurla', 'कुर्ला'] },
  { name: 'Chembur', lat: 19.062, lng: 72.9, aliases: ['chembur', 'चेंबूर'] },
  { name: 'Govandi', lat: 19.055, lng: 72.915, aliases: ['govandi', 'गोवंडी'] },
  { name: 'Mankhurd', lat: 19.048, lng: 72.932, aliases: ['mankhurd', 'मानखुर्द'] },
  { name: 'Ghatkopar', lat: 19.086, lng: 72.908, aliases: ['ghatkopar', 'घाटकोपर'] },
  { name: 'Vikhroli', lat: 19.111, lng: 72.928, aliases: ['vikhroli', 'विक्रोली', 'विखरोळी'] },
  { name: 'Powai', lat: 19.1176, lng: 72.906, aliases: ['powai', 'पवई'] },
  { name: 'Bhandup', lat: 19.145, lng: 72.938, aliases: ['bhandup', 'भांडुप'] },
  { name: 'Mulund', lat: 19.172, lng: 72.956, aliases: ['mulund', 'मुलुंड'] },
  { name: 'Santacruz', lat: 19.081, lng: 72.841, aliases: ['santacruz', 'santa cruz', 'सांताक्रूझ', 'सांताक्रुज'] },
  { name: 'Mumbai Airport', lat: 19.0896, lng: 72.8656, aliases: ['airport', 'एयरपोर्ट', 'विमानतळ'] },
  { name: 'Vile Parle', lat: 19.099, lng: 72.849, aliases: ['vile parle', 'विले पार्ले'] },
  { name: 'Juhu', lat: 19.0883, lng: 72.8264, aliases: ['juhu', 'जुहू'] },
  { name: 'Andheri', lat: 19.1197, lng: 72.8464, aliases: ['andheri', 'अंधेरी'] },
  { name: 'Jogeshwari', lat: 19.136, lng: 72.849, aliases: ['jogeshwari', 'जोगेश्वरी'] },
  { name: 'Goregaon', lat: 19.155, lng: 72.849, aliases: ['goregaon', 'गोरेगांव', 'गोरेगाव'] },
  { name: 'Malad', lat: 19.187, lng: 72.8489, aliases: ['malad', 'मालाड'] },
  { name: 'Kandivali', lat: 19.204, lng: 72.852, aliases: ['kandivali', 'कांदिवली'] },
  { name: 'Borivali', lat: 19.2307, lng: 72.8567, aliases: ['borivali', 'बोरीवली', 'बोरिवली'] },
  { name: 'Dahisar', lat: 19.25, lng: 72.86, aliases: ['dahisar', 'दहिसर'] },
  { name: 'Vashi', lat: 19.077, lng: 72.999, aliases: ['vashi', 'वाशी'] },
  { name: 'Navi Mumbai', lat: 19.033, lng: 73.0297, aliases: ['navi mumbai', 'नवी मुंबई'] },
  { name: 'Thane', lat: 19.2183, lng: 72.9781, aliases: ['thane', 'ठाणे'] },
];
const ALIASES = LANDMARKS
  .flatMap((l) => l.aliases.map((alias) => ({ alias, landmark: l })))
  .sort((a, b) => b.alias.length - a.alias.length);

/** Area named in free text (offline gazetteer). Longest alias wins ("lower parel" over "parel"). */
export function matchLandmark(message: string) {
  const lower = message.toLowerCase();
  for (const { alias, landmark } of ALIASES) {
    const hit = /[a-z]/.test(alias)
      ? new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)
      : lower.includes(alias);
    if (hit) return landmark;
  }
  return null;
}

// ── Resolution ────────────────────────────────────────────────────────────────
export const LOCATION_CONFIG = {
  /** A GPS fix with a stated accuracy at or below this is "accurate". Unknown accuracy is treated as this × 2. */
  accurateGpsM: 150,
  /** Text candidate within this distance (plus GPS accuracy) of the GPS fix is consistent with it. */
  gpsConsistentM: 400,
  /** Beyond this the text location and GPS disagree. */
  gpsConflictM: 1500,
  /** Two candidates this far apart are different places. */
  distinctPlaceM: 1000,
  /** Scores (0..1). */
  exactMinScore: 0.62,
  exactMinName: 0.6,
  approxMinScore: 0.45,
  ambiguityMargin: 0.12,
};
const L = LOCATION_CONFIG;

interface Scored { c: GeoCandidate; kind: 'point' | 'road' | 'area'; score: number; nameSim: number; inScope: boolean; query: string; reason?: string }

function parseName(name: string | null): { place: string | null; locality: string | null } {
  if (!name) return { place: null, locality: null };
  const parts = name.split(',').map((p) => p.trim()).filter((p) => p && !/^(mumbai|india|maharashtra)$/i.test(p));
  return { place: parts[0] ?? null, locality: parts[1] ?? null };
}

function metaBase(structured: StructuredLocation, gemini: { lat: number; lng: number } | null, gps: { lat: number; lng: number; accuracy_m: number | null } | null): Omit<LocationMeta, 'precision' | 'confidence' | 'accuracy_m' | 'source' | 'result' | 'matched_query' | 'gps_consistency' | 'needs_verification'> {
  return {
    version: 1, original_text: structured.text, structured, ambiguous: false, candidates: [], gemini_estimate: gemini,
    reporter_gps: gps, notes: [], geocoder: geocoder.id, geocoder_error: null,
  };
}

/** Maps the precision class onto the existing location_source values the UI already understands. */
function sourceFor(meta: LocationMeta): LocationSource {
  // A GPS fix is a measurement: keep its label even when the text could not confirm it.
  if (meta.source === 'reporter_gps') return 'reporter_gps';
  if (meta.needs_verification && meta.precision !== 'area' && meta.precision !== 'ai_estimate') return 'unverified';
  switch (meta.precision) {
    case 'verified':
    case 'exact':
    case 'approximate': return 'geocoded';
    case 'area': return 'landmark';
    case 'ai_estimate': return 'ai_estimate';
    default: return 'unverified';
  }
}

export interface ResolveInput {
  location_name: string | null;
  location_lat: number | null;
  location_lng: number | null;
  location?: Partial<StructuredLocation> | null;
}

export async function resolveLocation(
  extracted: ResolveInput,
  message: string,
  reporter: { lat: number; lng: number; accuracy_m?: number | null } | null,
): Promise<ResolvedLocation> {
  const parsed = parseName(extracted.location_name);
  const structured: StructuredLocation = {
    text: extracted.location?.text ?? extracted.location_name ?? null,
    place: extracted.location?.place ?? parsed.place,
    locality: extracted.location?.locality ?? parsed.locality,
    city: extracted.location?.city ?? null,
    state: extracted.location?.state ?? null,
    country: extracted.location?.country ?? 'India',
  };
  const gemini = extracted.location_lat != null && extracted.location_lng != null ? { lat: extracted.location_lat, lng: extracted.location_lng } : null;
  const gps = reporter ? { lat: reporter.lat, lng: reporter.lng, accuracy_m: reporter.accuracy_m ?? null } : null;
  const gpsAcc = gps ? (gps.accuracy_m ?? L.accurateGpsM * 2) : null;
  const gpsAccurate = !!gps && gpsAcc! <= L.accurateGpsM * 2;
  const allowed = allowedCities(message, structured);
  const base = metaBase(structured, gemini, gps);
  const displayName = structured.place && structured.locality ? `${structured.place}, ${structured.locality}` : structured.place ?? structured.locality ?? extracted.location_name;

  // ── 1. Geocoder candidates for the specific place (with and without locality) ──
  const scored: Scored[] = [];
  const queries: string[] = [];
  if (structured.place) {
    if (structured.locality) queries.push(`${structured.place}, ${structured.locality}`);
    queries.push(structured.place);
  }
  let geocoderError: string | null = null;
  // Context for the query: Mumbai, unless the report explicitly names a neighbouring city.
  const cityHint = [...allowed].find((c) => c !== 'Mumbai') ?? 'Mumbai';
  for (const q of queries) {
    let results: GeoCandidate[] = [];
    try {
      results = await geocoder.search(`${q}, ${cityHint}`);
    } catch (err) {
      geocoderError = (err as Error).message;
      break;
    }
    for (const c of results) {
      const kind = kindOf(c);
      const city = candidateCity(c);
      const inScope = !!city && allowed.has(city);
      const nameSim = Math.max(containment(structured.place, c.name), 0.9 * containment(structured.place, c.display_name));
      const locText = `${Object.values(c.address ?? {}).join(' ')} ${c.display_name}`;
      const locality = structured.locality ? containment(structured.locality, locText) : 0.5;
      const typeScore = kind === 'point' ? 1 : kind === 'road' ? 0.6 : 0.3;
      const gpsScore = gps ? Math.exp(-distanceM(c, gps) / (gpsAcc! + 800)) : null;
      const gemScore = gemini ? Math.exp(-distanceM(c, gemini) / 4000) : 0.5;
      const importance = Math.min(1, Math.max(0, c.importance));
      let score = gpsScore === null
        ? 0.45 * nameSim + 0.25 * locality + 0.15 * typeScore + 0.1 * gemScore + 0.05 * importance
        : 0.35 * nameSim + 0.2 * locality + 0.1 * typeScore + 0.25 * gpsScore + 0.05 * gemScore + 0.05 * importance;
      if (!inScope) score = 0;
      scored.push({ c, kind, score, nameSim, inScope, query: q, reason: inScope ? undefined : `outside allowed area (${city ?? 'unknown city'})` });
    }
    if (scored.some((s) => s.inScope && s.kind === 'point' && s.nameSim >= L.exactMinName && s.score >= L.exactMinScore)) break;
  }
  base.geocoder_error = geocoderError;
  // Keep one entry per distinct place (the geocoder repeats objects across queries).
  const unique: Scored[] = [];
  for (const s of scored.sort((a, b) => b.score - a.score)) {
    if (!unique.some((u) => distanceM(u.c, s.c) < 60 && u.kind === s.kind)) unique.push(s);
  }
  base.candidates = unique.slice(0, 6).map((s) => ({ name: s.c.display_name || s.c.name, lat: s.c.lat, lng: s.c.lng, kind: s.kind, score: Math.round(s.score * 1000) / 1000, in_scope: s.inScope, reason: s.reason }));

  const specific = unique.filter((s) => s.inScope && s.kind !== 'area' && s.nameSim >= 0.5);
  let best = specific[0] ?? null;
  // Ambiguity: two well-matching specific candidates at clearly different places with similar scores.
  const rival = best ? specific.find((s) => s !== best && distanceM(s.c, best!.c) > L.distinctPlaceM && best!.score - s.score < L.ambiguityMargin) : null;
  let ambiguous = !!rival;
  const notes: string[] = [];
  if (ambiguous && gps) {
    // GPS disambiguates when it clearly sits near one of them.
    const near = specific.filter((s) => distanceM(s.c, gps) <= gpsAcc! + L.gpsConflictM).sort((a, b) => distanceM(a.c, gps) - distanceM(b.c, gps));
    if (near.length && (near.length === 1 || distanceM(near[0].c, gps) * 2 < distanceM(near[1].c, gps))) {
      best = near[0];
      ambiguous = false;
      notes.push('same-name candidates disambiguated by reporter GPS');
    }
  }

  const finish = (lat: number, lng: number, name: string | null, meta: Omit<LocationMeta, keyof typeof base> & Partial<typeof base>): ResolvedLocation => {
    const full = { ...base, ...meta, notes: [...notes, ...(meta.notes ?? [])] } as LocationMeta;
    full.confidence = Math.round(full.confidence * 1000) / 1000;
    full.accuracy_m = Math.round(full.accuracy_m);
    return { lat, lng, name, source: sourceFor(full), meta: full };
  };

  // ── 2. A specific place was found ──
  if (best) {
    const exact = best.kind === 'point' && best.nameSim >= L.exactMinName && best.score >= L.exactMinScore && !ambiguous;
    let precision: LocationPrecision = exact ? 'exact' : best.score >= L.approxMinScore ? 'approximate' : 'unverified';
    let confidence = best.score * (ambiguous ? 0.5 : 1);
    let consistency: LocationMeta['gps_consistency'] = gps ? 'consistent' : 'not_available';
    if (gps) {
      const d = distanceM(best.c, gps);
      if (d <= L.gpsConsistentM + gpsAcc!) {
        confidence = Math.min(1, confidence + 0.15);
        if (precision === 'approximate' && best.nameSim >= L.exactMinName) precision = 'exact';
      } else if (d > L.gpsConflictM + gpsAcc!) {
        consistency = 'conflict';
        notes.push(`text location is ${(d / 1000).toFixed(1)} km from the reporter's GPS`);
        if (gpsAccurate && !exact) {
          // Weak text match far from an accurate fix: the fix is the better evidence.
          return finish(gps.lat, gps.lng, displayName ?? "Reporter's GPS location", {
            precision: (gps.accuracy_m ?? Infinity) <= L.accurateGpsM ? 'exact' : 'approximate',
            confidence: 0.6, accuracy_m: gpsAcc!, source: 'reporter_gps', matched_query: null, result: null,
            ambiguous, gps_consistency: 'used', needs_verification: true,
            notes: ['weak/ambiguous text match conflicts with reporter GPS; GPS used, verify with reporter'],
          });
        }
        confidence *= 0.6;
      }
    }
    const needsVerification = ambiguous || precision !== 'exact' || consistency === 'conflict';
    return finish(best.c.lat, best.c.lng, displayName ?? best.c.name, {
      precision: ambiguous ? 'unverified' : precision, confidence, accuracy_m: accuracyOf(best.c, best.kind),
      source: 'geocoder', matched_query: best.query,
      result: { name: best.c.name, category: best.c.category, type: best.c.type, kind: best.kind },
      ambiguous, gps_consistency: consistency, needs_verification: needsVerification,
      notes: ambiguous ? [`ambiguous: "${best.c.name}" matches several places (e.g. ${rival!.c.display_name.split(',').slice(0, 2).join(',')})`] : [],
    });
  }

  // ── 3. No specific place: reporter GPS (checked against any area the text names) ──
  if (gps && gpsAccurate) {
    const named = unique.filter((s) => s.inScope && s.kind === 'area' && containment(structured.locality ?? structured.place, s.c.name) >= 0.5);
    const lm = matchLandmark(`${structured.locality ?? ''} ${structured.place ?? ''}`);
    const inside = named.find((s) => distanceM(s.c, gps) <= accuracyOf(s.c, 'area') + gpsAcc!)
      ?? (lm && distanceM(lm, gps) <= 1500 + gpsAcc! ? { c: { display_name: lm.name } } : null);
    const textGiven = !!(structured.place || structured.locality);
    return finish(gps.lat, gps.lng, displayName ?? "Reporter's GPS location", {
      precision: (gps.accuracy_m ?? Infinity) <= L.accurateGpsM ? 'exact' : 'approximate',
      confidence: inside ? 0.85 : (gps.accuracy_m ?? Infinity) <= L.accurateGpsM ? 0.75 : 0.6, accuracy_m: gpsAcc!,
      source: 'reporter_gps', matched_query: null, result: null, gps_consistency: 'used',
      needs_verification: textGiven && !inside,
      notes: inside ? [`reporter GPS lies in ${inside.c.display_name.split(',').slice(0, 2).join(',')}, consistent with the report`]
        : textGiven ? [`"${structured.place ?? structured.locality}" could not be confirmed on the map; reporter GPS used`] : [],
    });
  }

  // ── 4. Area level: the locality from the geocoder, else the offline gazetteer ──
  const areaText = structured.locality ?? (structured.place && !queries.length ? structured.place : null);
  let area: { lat: number; lng: number; name: string; acc: number; query: string | null; source: 'geocoder' | 'gazetteer' } | null = null;
  const areaMatches = unique.filter((s) => s.inScope && s.kind === 'area' && containment(areaText ?? structured.place, s.c.name) >= 0.5);
  const areaFromGeocoder = areaMatches[0];
  // Same-name areas in different parts of the city (e.g. several "Shivaji Nagar"s): do not pick one silently.
  const areaRival = areaFromGeocoder && areaMatches.find((s) => s !== areaFromGeocoder && distanceM(s.c, areaFromGeocoder.c) > L.distinctPlaceM * 2);
  if (areaRival && !(gps && gpsAccurate)) {
    return finish(areaFromGeocoder.c.lat, areaFromGeocoder.c.lng, displayName ?? areaFromGeocoder.c.name, {
      precision: 'unverified', confidence: 0.1, accuracy_m: accuracyOf(areaFromGeocoder.c, 'area'), source: 'geocoder',
      matched_query: areaFromGeocoder.query, result: { name: areaFromGeocoder.c.name, category: 'place', type: 'area', kind: 'area' },
      ambiguous: true, gps_consistency: gps ? 'consistent' : 'not_available', needs_verification: true,
      notes: [`ambiguous area: "${areaFromGeocoder.c.name}" exists in several places (e.g. ${areaRival.c.display_name.split(',').slice(0, 2).join(',')})`],
    });
  }
  if (areaRival && gps) {
    // Accurate GPS picks the matching area (or stands alone if it matches none).
    const near = areaMatches.find((s) => distanceM(s.c, gps) <= accuracyOf(s.c, 'area') + gpsAcc!);
    return finish(gps.lat, gps.lng, displayName ?? near?.c.name ?? "Reporter's GPS location", {
      precision: (gps.accuracy_m ?? Infinity) <= L.accurateGpsM ? 'exact' : 'approximate', confidence: near ? 0.8 : 0.6,
      accuracy_m: gpsAcc!, source: 'reporter_gps', matched_query: areaFromGeocoder.query, result: null, ambiguous: false,
      gps_consistency: 'used', needs_verification: !near,
      notes: [near ? `GPS lies in ${near.c.display_name.split(',').slice(0, 2).join(',')}; used to resolve same-name areas` : 'GPS matches none of the same-name areas'],
    });
  }
  if (areaFromGeocoder) {
    area = { lat: areaFromGeocoder.c.lat, lng: areaFromGeocoder.c.lng, name: areaFromGeocoder.c.name, acc: accuracyOf(areaFromGeocoder.c, 'area'), query: areaFromGeocoder.query, source: 'geocoder' };
  } else if (areaText && !geocoderError) {
    try {
      const rows = await geocoder.search(`${areaText}, Mumbai`);
      const hit = rows.map((c) => ({ c, kind: kindOf(c), city: candidateCity(c) }))
        .find((x) => x.kind === 'area' && !!x.city && allowed.has(x.city) && containment(areaText, x.c.name) >= 0.5);
      if (hit) area = { lat: hit.c.lat, lng: hit.c.lng, name: hit.c.name, acc: accuracyOf(hit.c, 'area'), query: areaText, source: 'geocoder' };
    } catch (err) {
      base.geocoder_error = (err as Error).message;
    }
  }
  if (!area) {
    const lm = matchLandmark(`${message} ${structured.locality ?? ''} ${structured.place ?? ''}`);
    if (lm && (lm.name !== 'Navi Mumbai' && lm.name !== 'Vashi' && lm.name !== 'Thane' || allowed.size > 1)) {
      area = { lat: lm.lat, lng: lm.lng, name: lm.name, acc: 1500, query: null, source: 'gazetteer' };
    }
  }
  if (area) {
    let consistency: LocationMeta['gps_consistency'] = gps ? 'consistent' : 'not_available';
    if (gps && distanceM(area, gps) > area.acc + gpsAcc!) consistency = 'conflict';
    // A rough GPS fix inside the named area is better than the area centroid.
    if (gps && consistency === 'consistent') {
      return finish(gps.lat, gps.lng, displayName ?? area.name, {
        precision: 'approximate', confidence: 0.55, accuracy_m: gpsAcc!, source: 'reporter_gps', matched_query: area.query,
        result: null, gps_consistency: 'used', needs_verification: true, notes: [`reporter GPS lies inside ${area.name}; exact place not found`],
      });
    }
    return finish(area.lat, area.lng, displayName ? `${displayName} (area: ${area.name})` : area.name, {
      precision: 'area', confidence: 0.3, accuracy_m: area.acc, source: area.source, matched_query: area.query,
      result: { name: area.name, category: 'place', type: 'area', kind: 'area' }, gps_consistency: consistency,
      needs_verification: true,
      notes: [structured.place ? `"${structured.place}" not found; only the area "${area.name}" is known` : `only the area "${area.name}" is known`],
    });
  }

  // ── 5. Rough GPS, then Gemini's estimate (flagged, never treated as fact), then nothing ──
  if (gps) {
    return finish(gps.lat, gps.lng, displayName ?? "Reporter's GPS location", {
      precision: 'approximate', confidence: 0.4, accuracy_m: gpsAcc!, source: 'reporter_gps', matched_query: null, result: null,
      gps_consistency: 'used', needs_verification: true, notes: ['GPS accuracy unknown or low'],
    });
  }
  if (gemini && inBox(GREATER_MUMBAI, gemini.lat, gemini.lng)) {
    return finish(gemini.lat, gemini.lng, displayName ?? 'AI-estimated location', {
      precision: 'ai_estimate', confidence: 0.15, accuracy_m: 3000, source: 'ai_estimate', matched_query: null, result: null,
      gps_consistency: 'not_available', needs_verification: true,
      notes: ['no geocoder match; coordinates are an AI estimate from the text and must be verified'],
    });
  }
  return finish(CITY_CENTRE.lat, CITY_CENTRE.lng, displayName ?? 'Location not given', {
    precision: 'unverified', confidence: 0, accuracy_m: 15000, source: 'city_centre', matched_query: null, result: null,
    gps_consistency: 'not_available', needs_verification: true, notes: ['no usable location; placeholder at city centre'],
  });
}

/** Precision classes that are reliable enough for automatic decisions (deduplication). */
export function locationReliability(meta: Partial<LocationMeta> | null | undefined, source?: string | null): number {
  const p = meta?.precision ?? (source === 'geocoded' ? 'approximate' : source === 'reporter_gps' ? 'approximate' : source === 'landmark' ? 'area' : source === 'ai_estimate' ? 'ai_estimate' : 'unverified');
  const base = { verified: 1, exact: 0.95, approximate: 0.65, area: 0.3, ai_estimate: 0.15, unverified: 0.05 }[p as LocationPrecision] ?? 0.05;
  return meta?.ambiguous ? Math.min(base, 0.3) : base;
}

export function accuracyRadius(meta: Partial<LocationMeta> | null | undefined, source?: string | null): number {
  if (meta?.accuracy_m) return meta.accuracy_m;
  return source === 'geocoded' ? 400 : source === 'reporter_gps' ? 300 : source === 'landmark' ? 1500 : source === 'ai_estimate' ? 3000 : 15000;
}
