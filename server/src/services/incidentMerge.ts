/**
 * Shared merge/candidate logic for duplicate reports and coordinator-confirmed duplicates.
 * All functions run inside the caller's transaction.
 */
import type { Queryable, Row } from '../db.js';
import { ACTIVE_INCIDENT_STATUSES, sqlList } from '../constants.js';
import { audit } from './audit.js';
import type { AuthUser } from '../auth.js';
import { buildIncidentDemand } from './allocation/demand.js';
import {
  assessRisk, higherPriority, incidentEvidence, mergeEvidence, operationalPriority,
  type RiskAssessment, type RiskEvidence,
} from './riskAssessment.js';
import { DEDUP_CONFIG, searchRadiusM, type DedupCandidate, type DedupSignal } from './deduplication.js';
import { accuracyRadius, distanceM, locationReliability, type LocationMeta } from './locate.js';

const ACTIVE = sqlList(ACTIVE_INCIDENT_STATUSES);

/** Identifies the incident's resource demand; a change means allocation must be reconsidered. */
export function demandSignature(row: Row): string {
  return buildIncidentDemand(row as never).slots
    .map((s) => `${s.resource_type}#${s.index}:${s.required_caps.join('+')}:${s.capacity_need}`).join('|');
}

export function placeOf(row: Row): string | null {
  const meta = row.location_meta as LocationMeta | null;
  return meta?.structured?.place ?? (typeof row.location_name === 'string' ? row.location_name.split(/[,(]/)[0].trim() || null : null);
}

/** Active incidents that could possibly be the same event (spatial box + recent activity), with their reports. */
export async function loadDedupCandidates(q: Queryable, s: DedupSignal, excludeId?: string): Promise<DedupCandidate[]> {
  const r = searchRadiusM(s);
  const dLat = r / 111_000;
  const dLng = r / (111_000 * Math.cos((s.lat * Math.PI) / 180));
  const since = new Date(s.reported_at.getTime() - DEDUP_CONFIG.windowMin * 60_000);
  const params: unknown[] = [s.lat - dLat, s.lat + dLat, s.lng - dLng, s.lng + dLng, since];
  if (excludeId) params.push(excludeId);
  const rows = await q.query(
    `SELECT * FROM incidents
     WHERE status IN (${ACTIVE}) AND parent_incident_id IS NULL
       AND location_lat BETWEEN $1 AND $2 AND location_lng BETWEEN $3 AND $4
       AND COALESCE(last_report_at, created_at) > $5 ${excludeId ? 'AND id <> $6' : ''}`,
    params,
  );
  if (!rows.length) return [];
  const ids = rows.map((x) => x.id as string);
  const reports = await q.query(
    `SELECT incident_id, raw_message, reporter_lat, reporter_lng FROM reports
     WHERE incident_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`,
    ids,
  );
  return rows.map((row) => {
    const mine = reports.filter((x) => x.incident_id === row.id);
    return {
      id: row.id, type: row.type, lat: row.location_lat, lng: row.location_lng,
      location_meta: row.location_meta, location_source: row.location_source, place: placeOf(row),
      texts: [row.raw_message, row.title, ...mine.map((x) => x.raw_message)].filter(Boolean),
      evidence: incidentEvidence(row),
      last_activity: new Date(row.last_report_at ?? row.created_at),
      gps: mine.filter((x) => x.reporter_lat != null).map((x) => ({ lat: x.reporter_lat, lng: x.reporter_lng })),
    };
  });
}

/** Signal describing an existing incident (for re-checking after a location correction). */
export async function signalForIncident(q: Queryable, row: Row): Promise<DedupSignal> {
  const texts = await q.query('SELECT raw_message, reporter_lat, reporter_lng FROM reports WHERE incident_id = $1', [row.id]);
  const gps = texts.find((t) => t.reporter_lat != null);
  return {
    type: row.type, lat: row.location_lat, lng: row.location_lng, location_meta: row.location_meta,
    location_source: row.location_source, place: placeOf(row),
    text: [row.raw_message, ...texts.map((t) => t.raw_message)].filter(Boolean).join(' '),
    evidence: incidentEvidence(row), reported_at: new Date(row.last_report_at ?? row.created_at),
    gps: gps ? { lat: gps.reporter_lat, lng: gps.reporter_lng } : null,
  };
}

export interface MergeAddition {
  evidence: RiskEvidence;
  people_affected: number;
  injuries: number;
  has_children: boolean;
  has_elderly: boolean;
  has_disabled: boolean;
  urgency_indicators: string[];
  reported_at: Date;
  reports_added: number;
  /** A location that may be more precise than the incident's current one. */
  location?: { lat: number; lng: number; name: string | null; source: string; meta: Partial<LocationMeta> | null } | null;
}

export interface MergeOutcome {
  incident: Row;
  riskChanged: boolean;
  demandChanged: boolean;
  locationRefined: boolean;
}

/**
 * Merges new evidence into an incident: evidence, summary fields, risk re-assessment (priority is
 * never lowered: it may have been escalated), optional location refinement, explicit audit entry.
 */
export async function mergeIntoIncident(
  tx: Queryable, incidentId: string, add: MergeAddition,
  ctx: { report_id?: string | null; merged_incident_id?: string | null; score?: number | null; reasons?: string[]; user?: AuthUser | null },
): Promise<MergeOutcome> {
  const current = (await tx.one('SELECT * FROM incidents WHERE id = $1 FOR UPDATE', [incidentId]))!;
  const demandBefore = demandSignature(current);
  const previous = current.risk_assessment as RiskAssessment | null;
  const combined = mergeEvidence(incidentEvidence(current), add.evidence);
  const assessment = assessRisk(combined, 'merged', (previous?.reports_combined ?? current.corroborating_reports ?? 1) + add.reports_added);
  const next = assessment.status === 'ok'
    ? higherPriority({ priority: current.priority, priority_score: current.priority_score }, operationalPriority(assessment))
    : { priority: current.priority, priority_score: current.priority_score };

  // Adopt the new location only when it is clearly more reliable and consistent with the current one.
  let loc: MergeAddition['location'] = null;
  if (add.location) {
    const better = locationReliability(add.location.meta, add.location.source) >= locationReliability(current.location_meta, current.location_source) + 0.2;
    const consistent = distanceM(add.location, { lat: current.location_lat, lng: current.location_lng })
      <= accuracyRadius(current.location_meta, current.location_source) + accuracyRadius(add.location.meta, add.location.source) + 300;
    if (better && consistent) loc = add.location;
  }

  const urgency = [...new Set([...(current.urgency_indicators ?? []), ...add.urgency_indicators])].slice(0, 10);
  const updated = (await tx.one(
    `UPDATE incidents SET
       corroborating_reports = corroborating_reports + $2,
       confidence = LEAST(1, confidence + 0.1),
       people_affected = GREATEST(people_affected, $3), injuries = GREATEST(injuries, $4),
       has_children = has_children OR $5, has_elderly = has_elderly OR $6, has_disabled = has_disabled OR $7,
       urgency_indicators = $8,
       last_report_at = GREATEST(COALESCE(last_report_at, created_at), $9),
       risk_assessment = $10, priority = $11, priority_score = $12,
       location_lat = COALESCE($13, location_lat), location_lng = COALESCE($14, location_lng),
       location_name = COALESCE($15, location_name), location_source = COALESCE($16, location_source),
       location_meta = COALESCE($17, location_meta),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      incidentId, add.reports_added, Math.max(0, add.people_affected), Math.max(0, add.injuries),
      add.has_children, add.has_elderly, add.has_disabled, JSON.stringify(urgency), add.reported_at,
      JSON.stringify(assessment), next.priority, next.priority_score,
      loc?.lat ?? null, loc?.lng ?? null, loc?.name ?? null, loc?.source ?? null, loc?.meta ? JSON.stringify(loc.meta) : null,
    ],
  ))!;
  const demandChanged = demandSignature(updated) !== demandBefore;
  const riskChanged = updated.priority_score !== current.priority_score || updated.priority !== current.priority
    || (previous?.status === 'ok' ? previous.model_class : null) !== (assessment.status === 'ok' ? assessment.model_class : null);

  await audit(tx, {
    entityType: 'incident', entityId: incidentId, incidentId, action: 'merged', user: ctx.user ?? null,
    details: {
      report_id: ctx.report_id ?? null, merged_incident_id: ctx.merged_incident_id ?? null, target_incident_id: incidentId,
      duplicate_score: ctx.score ?? null, reasons: ctx.reasons ?? [],
      model_class_before: previous?.status === 'ok' ? previous.model_class : null,
      model_class_after: assessment.status === 'ok' ? assessment.model_class : 'unavailable',
      priority_before: current.priority, priority_after: updated.priority,
      demand_changed: demandChanged, location_refined: !!loc,
    },
  });
  return { incident: updated, riskChanged, demandChanged, locationRefined: !!loc };
}

/** Existing report with this client_id (idempotent retries). */
export async function findReportByClientId(q: Queryable, clientId: string | null) {
  if (!clientId) return null;
  const report = await q.one('SELECT * FROM reports WHERE client_id = $1', [clientId]);
  if (!report) return null;
  const incident = report.incident_id ? await q.one('SELECT * FROM incidents WHERE id = $1', [report.incident_id]) : null;
  return { report, incident };
}
