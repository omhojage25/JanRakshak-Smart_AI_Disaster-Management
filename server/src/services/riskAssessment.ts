import type { Priority } from '../constants.js';
import {
  FEATURE_ORDER, MODEL_CLASS_ORDER, MODEL_INCIDENT_TYPES, loadRiskModel, predictProbabilities,
  type ModelIncidentType, type RiskClass,
} from './riskModel.js';

/**
 * Emergency risk assessment: structured evidence → XGBoost class → derived score.
 *
 * XGBoost-based emergency risk classification proof-of-concept. Test accuracy 95.57% on the
 * generated evaluation dataset; its labels come from a deterministic rubric over these same
 * features, so this reproduces that rubric and is NOT a validated real-world severity predictor.
 *
 * Gemini (or the keyword fallback) only extracts evidence; it never sets the risk class.
 */

/** Count convention from training: 0 = no evidence, -1 = present but count unknown, N = count. */
export interface RiskEvidence {
  people_affected: number;
  injured: number;
  trapped: number;
  children: number;
  elderly: number;
  disabled: number;
  fire: 0 | 1;
  flood: 0 | 1;
  earthquake: 0 | 1;
  storm: 0 | 1;
  building_damage: 0 | 1;
  search_rescue: 0 | 1;
  medical_emergency: 0 | 1;
  urgency_indicators: 0 | 1;
}

const COUNT_FIELDS = ['people_affected', 'injured', 'trapped', 'children', 'elderly', 'disabled'] as const;
const FLAG_FIELDS = ['fire', 'flood', 'earthquake', 'storm', 'building_damage', 'search_rescue', 'medical_emergency', 'urgency_indicators'] as const;

export const EMPTY_EVIDENCE: RiskEvidence = {
  people_affected: 0, injured: 0, trapped: 0, children: 0, elderly: 0, disabled: 0,
  fire: 0, flood: 0, earthquake: 0, storm: 0, building_damage: 0, search_rescue: 0, medical_emergency: 0, urgency_indicators: 0,
};

/** Derived severity score per class (a presentation / decision-support value, not a probability). */
const CLASS_SEVERITY: Record<RiskClass, number> = { CRITICAL: 95, HIGH: 70, MEDIUM: 45, LOW: 20 };

export type RiskAssessment =
  | {
    status: 'ok';
    model_class: RiskClass;
    model_score: number;
    probabilities: Record<RiskClass, number>;
    evidence: RiskEvidence & { incident_type: ModelIncidentType };
    factors: string[];
    evidence_source: 'gemini' | 'keyword' | 'merged';
    reports_combined: number;
    model_version: string;
    assessed_at: string;
  }
  | {
    status: 'unavailable';
    reason: string;
    evidence: RiskEvidence;
    evidence_source: 'gemini' | 'keyword' | 'merged';
    reports_combined: number;
    assessed_at: string;
  };

/** Sanitises any evidence-shaped input to the training convention (missing → 0, never invented). */
export function normalizeEvidence(raw: Partial<Record<keyof RiskEvidence, unknown>> | null | undefined): RiskEvidence {
  const out = { ...EMPTY_EVIDENCE };
  for (const f of COUNT_FIELDS) {
    const n = Number(raw?.[f]);
    out[f] = !Number.isFinite(n) ? 0 : n === -1 ? -1 : n < 0 ? 0 : Math.min(Math.round(n), 10_000_000);
  }
  for (const f of FLAG_FIELDS) {
    const v = raw?.[f];
    out[f] = v === true || v === 1 ? 1 : 0;
  }
  return out;
}

/**
 * The model's incident_type feature, generated exactly as in the training data: a fixed
 * hazard-priority rule over the evidence (verified 100% on the original extracted rows).
 * Independent of the app's own incident type.
 */
export function modelIncidentType(e: RiskEvidence): ModelIncidentType {
  if (e.earthquake) return 'earthquake';
  if (e.fire) return 'fire';
  if (e.flood) return 'flood';
  if (e.storm) return 'storm';
  if (e.building_damage) return 'building_collapse';
  if (e.medical_emergency) return 'medical';
  if (e.search_rescue) return 'search_rescue';
  return COUNT_FIELDS.some((f) => e[f] !== 0) ? 'other' : 'unknown';
}

/** Feature row in the exact training order, incident_type label-encoded. */
export function encodeFeatures(e: RiskEvidence): number[] {
  const type = modelIncidentType(e);
  return FEATURE_ORDER.map((f) => (f === 'incident_type' ? MODEL_INCIDENT_TYPES.indexOf(type) : e[f]));
}

export function riskScore(p: Record<RiskClass, number>): number {
  return Math.round(MODEL_CLASS_ORDER.reduce((sum, cls) => sum + p[cls] * CLASS_SEVERITY[cls], 0));
}

const countText = (n: number, one: string, many: string, unknown: string) =>
  n === -1 ? unknown : n === 1 ? `1 ${one}` : `${n} ${many}`;

/** Plain-language list of the evidence actually given to the model. Ordered by global model importance. */
export function evidenceFactors(e: RiskEvidence): string[] {
  const out: string[] = [];
  if (e.injured) out.push(countText(e.injured, 'person injured', 'people injured', 'Injured people reported (number not stated)'));
  if (e.urgency_indicators) out.push('Urgent response indicators detected');
  if (e.trapped) out.push(countText(e.trapped, 'person reported trapped', 'people reported trapped', 'People reported trapped (number not stated)'));
  if (e.search_rescue) out.push('Search/rescue required');
  if (e.medical_emergency) out.push('Medical emergency reported');
  if (e.building_damage) out.push('Structural/building damage reported');
  if (e.people_affected) out.push(countText(e.people_affected, 'person affected', 'people affected', 'People affected (number not stated)'));
  if (e.elderly) out.push('Elderly people involved');
  if (e.children) out.push('Children involved');
  if (e.disabled) out.push('People with disabilities involved');
  if (e.storm) out.push('Storm/cyclone reported');
  if (e.flood) out.push('Flooding reported');
  if (e.fire) out.push('Fire reported');
  if (e.earthquake) out.push('Earthquake reported');
  return out;
}

export function assessRisk(
  evidence: RiskEvidence,
  source: 'gemini' | 'keyword' | 'merged',
  reportsCombined = 1,
): RiskAssessment {
  const assessedAt = new Date().toISOString();
  try {
    const probabilities = predictProbabilities(encodeFeatures(evidence));
    const modelClass = MODEL_CLASS_ORDER.reduce((best, cls) => (probabilities[cls] > probabilities[best] ? cls : best));
    const rounded = Object.fromEntries(MODEL_CLASS_ORDER.map((c) => [c, Math.round(probabilities[c] * 10_000) / 10_000])) as Record<RiskClass, number>;
    return {
      status: 'ok',
      model_class: modelClass,
      model_score: riskScore(probabilities),
      probabilities: rounded,
      evidence: { incident_type: modelIncidentType(evidence), ...evidence },
      factors: evidenceFactors(evidence),
      evidence_source: source,
      reports_combined: reportsCombined,
      model_version: loadRiskModel().version,
      assessed_at: assessedAt,
    };
  } catch (err) {
    console.error('[risk model] inference failed; risk assessment marked unavailable:', err);
    return {
      status: 'unavailable', reason: 'Model inference failed', evidence, evidence_source: source,
      reports_combined: reportsCombined, assessed_at: assessedAt,
    };
  }
}

/**
 * Operational priority written to incidents.priority / priority_score (dashboard sorting, workflow).
 * When the model is unavailable this is the schema's existing default (medium / 50) purely as a
 * safety value; the stored risk_assessment says "unavailable", so it is never presented as an ML result.
 */
export function operationalPriority(a: RiskAssessment): { priority: Priority; priority_score: number } {
  return a.status === 'ok'
    ? { priority: a.model_class.toLowerCase() as Priority, priority_score: a.model_score }
    : { priority: 'medium', priority_score: 50 };
}

/** Combines evidence from several reports of one incident: known counts beat unknown, larger beats smaller, flags OR. */
export function mergeEvidence(a: RiskEvidence, b: RiskEvidence): RiskEvidence {
  const out = { ...EMPTY_EVIDENCE };
  for (const f of COUNT_FIELDS) {
    const x = a[f];
    const y = b[f];
    out[f] = x > 0 || y > 0 ? Math.max(x, y) : x === -1 || y === -1 ? -1 : 0;
  }
  for (const f of FLAG_FIELDS) out[f] = a[f] || b[f] ? 1 : 0;
  return out;
}

/**
 * Evidence already on an incident: the stored assessment's evidence, or — for incidents created
 * before the model existed — only what the incident row itself records (no inference beyond it).
 */
export function incidentEvidence(row: Record<string, unknown>): RiskEvidence {
  const stored = row.risk_assessment as { evidence?: Partial<Record<keyof RiskEvidence, unknown>> } | null | undefined;
  if (stored?.evidence) return normalizeEvidence(stored.evidence);
  return normalizeEvidence({
    people_affected: row.people_affected as number,
    injured: row.injuries as number,
    children: row.has_children ? -1 : 0,
    elderly: row.has_elderly ? -1 : 0,
    disabled: row.has_disabled ? -1 : 0,
    fire: row.type === 'fire',
    flood: row.type === 'flood',
    building_damage: row.type === 'building_collapse',
  });
}

const PRIORITY_RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Higher of two operational priorities: a re-assessment never lowers an escalated/current priority. */
export function higherPriority(
  a: { priority: Priority; priority_score: number },
  b: { priority: Priority; priority_score: number },
): { priority: Priority; priority_score: number } {
  const hi = PRIORITY_RANK[a.priority] >= PRIORITY_RANK[b.priority] ? a : b;
  return { priority: hi.priority, priority_score: Math.max(a.priority_score, b.priority_score) };
}
