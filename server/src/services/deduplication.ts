/**
 * Duplicate-report detection. Every active incident near the report (spatial + recent-activity
 * prefilter) is scored; the best candidate decides:
 *
 *   score ≥ mergeThreshold  → merge into that incident
 *   score ≥ reviewThreshold → new incident, flagged "possible duplicate" for coordinator review
 *   otherwise               → new incident
 *
 * score = hazardCompatibility × ( wS·spatial·(0.3 + 0.7·locationReliability) + wP·placeSimilarity
 *                                + wT·textSimilarity + wE·evidenceSimilarity + wR·recency ) + gpsAdjustment
 *
 * Vetoes (never merge): incompatible hazards; too far apart for the locations' accuracy; the same
 * place NAME resolved to clearly different places; no activity within the time window.
 * Caps (at most "review"): either location is low-confidence (area centroid, AI estimate,
 * ambiguous, unverified); both locations precise but different named places; two near-equal targets.
 */
import type { RiskEvidence } from './riskAssessment.js';
import { accuracyRadius, containment, distanceM, locationReliability, tokens, type LocationMeta } from './locate.js';

export const DEDUP_CONFIG = {
  mergeThreshold: 0.72,
  reviewThreshold: 0.45,
  /** No merge if the incident has had no report for this long. */
  windowMin: 360,
  /** Recency decay (minutes): a report 2 h after the last one keeps ~37 % of the recency weight. */
  recencyTauMin: 120,
  /** Base distance for "same place", widened by both locations' accuracy radii. */
  baseRadiusM: 300,
  /** Veto beyond this (plus accuracies). */
  maxDistanceM: 3000,
  /** Same place name but further apart than this → different places with the same name. */
  sameNameDifferentPlaceM: 1500,
  /** Both precise, different names, further apart than this → not auto-merged. */
  precisePlaceSeparationM: 150,
  lowReliability: 0.5,
  weights: { spatial: 0.3, place: 0.2, text: 0.15, evidence: 0.1, recency: 0.25 },
} as const;
const D = DEDUP_CONFIG;

export interface DedupSignal {
  type: string;
  lat: number;
  lng: number;
  location_meta: Partial<LocationMeta> | null;
  location_source: string | null;
  place: string | null;
  text: string;
  evidence: RiskEvidence;
  reported_at: Date;
  gps: { lat: number; lng: number } | null;
}

export interface DedupCandidate {
  id: string;
  type: string;
  lat: number;
  lng: number;
  location_meta: Partial<LocationMeta> | null;
  location_source: string | null;
  place: string | null;
  texts: string[];
  evidence: RiskEvidence;
  last_activity: Date;
  gps: { lat: number; lng: number }[];
}

export interface DedupScore {
  incident_id: string;
  score: number;
  decision: 'merge' | 'review' | 'new';
  reasons: string[];
  components: Record<string, number | null>;
  veto: string | null;
}

// ── Components ────────────────────────────────────────────────────────────────
const FLAGS: (keyof RiskEvidence)[] = ['fire', 'flood', 'earthquake', 'storm', 'building_damage', 'search_rescue', 'medical_emergency'];
function evidenceSet(e: RiskEvidence): Set<string> {
  const s = new Set<string>(FLAGS.filter((f) => e[f]));
  if (e.trapped) s.add('trapped');
  if (e.injured) s.add('injured');
  return s;
}
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size && !b.size) return null;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

/** Same underlying event despite different incident types, when the evidence supports it. */
export function hazardCompatibility(a: string, b: string, ea: RiskEvidence, eb: RiskEvidence): number {
  if (a === b) return 1;
  const pair = [a, b].sort().join('|');
  const fire = ea.fire || eb.fire;
  const damage = ea.building_damage || eb.building_damage;
  switch (pair) {
    case 'fire|gas_leak': return fire ? 0.85 : 0.6;               // leak ignites / fire from a leak
    case 'building_collapse|fire': return fire && damage ? 0.8 : 0.4;
    case 'building_collapse|gas_leak': return damage ? 0.75 : 0.3; // explosion → collapse
    case 'building_collapse|flood': return damage ? 0.6 : 0.2;
    case 'fire|road_accident': return fire ? 0.6 : 0.2;           // vehicle fire
    default: return 0;
  }
}

function textSimilarity(a: string, others: string[]): number {
  const ta = new Set(tokens(a));
  let best = 0;
  for (const o of others) best = Math.max(best, jaccard(ta, new Set(tokens(o))) ?? 0);
  return Math.min(1, best * 1.6); // short messages rarely overlap fully
}

function placeSimilarity(a: string | null, b: string | null): number | null {
  if (!tokens(a).length || !tokens(b).length) return null;
  return Math.max(containment(a, b), containment(b, a));
}

// ── Scoring ───────────────────────────────────────────────────────────────────
export function scoreDuplicate(s: DedupSignal, c: DedupCandidate): DedupScore {
  const reasons: string[] = [];
  const result = (score: number, decision: DedupScore['decision'], components: DedupScore['components'], veto: string | null = null): DedupScore =>
    ({ incident_id: c.id, score: Math.round(score * 1000) / 1000, decision, reasons, components, veto });

  const hazard = hazardCompatibility(s.type, c.type, s.evidence, c.evidence);
  const d = distanceM(s, c);
  const accS = accuracyRadius(s.location_meta, s.location_source);
  const accC = accuracyRadius(c.location_meta, c.location_source);
  const reliability = Math.min(locationReliability(s.location_meta, s.location_source), locationReliability(c.location_meta, c.location_source));
  const minutes = Math.abs(s.reported_at.getTime() - c.last_activity.getTime()) / 60_000;
  const place = placeSimilarity(s.place, c.place);
  const components: DedupScore['components'] = {
    hazard, distance_m: Math.round(d), reliability, minutes_since_last_report: Math.round(minutes), place,
  };

  if (hazard === 0) { reasons.push(`incompatible incident types (${s.type} vs ${c.type})`); return result(0, 'new', components, 'incompatible_hazard'); }
  if (minutes > D.windowMin) { reasons.push(`no report on this incident for ${Math.round(minutes)} min`); return result(0, 'new', components, 'stale'); }
  if (place !== null && place >= 0.7 && d > Math.max(D.sameNameDifferentPlaceM, (accS + accC) * 1.5)) {
    reasons.push(`same place name "${s.place}" but ${(d / 1000).toFixed(1)} km apart: different places`);
    return result(0, 'new', components, 'same_name_different_place');
  }
  if (d > D.maxDistanceM + accS + accC) { reasons.push(`${Math.round(d)} m apart`); return result(0, 'new', components, 'too_far'); }

  const R = D.baseRadiusM + accS + accC;
  const spatial = Math.exp(-((d / R) ** 2));
  const text = textSimilarity(s.text, c.texts);
  const evidence = jaccard(evidenceSet(s.evidence), evidenceSet(c.evidence)) ?? 0.5;
  const recency = Math.exp(-minutes / D.recencyTauMin);
  let gpsAdj = 0;
  if (s.gps && c.gps.length) {
    const dg = Math.min(...c.gps.map((g) => distanceM(s.gps!, g)));
    gpsAdj = dg < 300 ? 0.08 : dg > 2000 ? -0.15 : 0;
    components.reporter_gps_distance_m = Math.round(dg);
  }
  const w = D.weights;
  const score = Math.max(0, Math.min(1, hazard * (
    w.spatial * spatial * (0.3 + 0.7 * reliability) + w.place * (place ?? 0.4) + w.text * text + w.evidence * evidence + w.recency * recency
  ) + gpsAdj));
  Object.assign(components, { spatial: round(spatial), text: round(text), evidence: round(evidence), recency: round(recency), gps_adjustment: gpsAdj });

  let decision: DedupScore['decision'] = score >= D.mergeThreshold ? 'merge' : score >= D.reviewThreshold ? 'review' : 'new';
  reasons.push(`${Math.round(d)} m apart, ${Math.round(minutes)} min since last report, score ${round(score)}`);
  if (decision === 'merge' && reliability < D.lowReliability) {
    decision = 'review';
    reasons.push('location confidence too low for an automatic merge');
  }
  if (decision === 'merge' && reliability >= 0.65 && d > D.precisePlaceSeparationM && (place === null || place < 0.4)) {
    decision = 'review';
    reasons.push('two precisely located, differently named places: not merged automatically');
  }
  return result(score, decision, components);
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export interface DedupDecision {
  decision: 'merge' | 'review' | 'new';
  target: DedupScore | null;
  scores: DedupScore[];
}

/** Evaluates every candidate; the best one decides. Two near-equal merge targets → review instead. */
export function decideDuplicate(s: DedupSignal, candidates: DedupCandidate[]): DedupDecision {
  const scores = candidates.map((c) => scoreDuplicate(s, c)).sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (!best || best.decision === 'new') return { decision: 'new', target: null, scores };
  const second = scores[1];
  if (best.decision === 'merge' && second && second.decision !== 'new' && best.score - second.score < 0.05) {
    best.reasons.push(`another incident scores almost the same (${second.score}); coordinator should choose`);
    return { decision: 'review', target: best, scores };
  }
  return { decision: best.decision, target: best, scores };
}

/** Prefilter box: anything that could possibly pass the distance veto. */
export function searchRadiusM(s: DedupSignal): number {
  return Math.min(10_000, D.maxDistanceM + accuracyRadius(s.location_meta, s.location_source) + 5000);
}
