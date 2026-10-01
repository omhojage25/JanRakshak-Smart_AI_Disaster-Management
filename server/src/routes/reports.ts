import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { route } from '../http.js';
import { latLng, optionalNumber, optionalString, requiredString, ValidationError } from '../validate.js';
import { classifyReport, type ClassificationResult } from '../services/classifier.js';
import { decideDuplicate, type DedupDecision, type DedupSignal } from '../services/deduplication.js';
import { findReportByClientId, loadDedupCandidates, mergeIntoIncident } from '../services/incidentMerge.js';
import { resolveLocation, type ResolvedLocation } from '../services/locate.js';
import { audit } from '../services/audit.js';
import { broadcast } from '../realtime.js';
import { propagateImpact } from '../services/impactPropagation.js';
import { ACTIVE_INCIDENT_STATUSES, DEFAULT_RADIUS_M, ESCALATION_THRESHOLD_MIN, sqlList } from '../constants.js';
import { notify } from '../services/notify.js';
import { reoptimize } from '../services/allocation/reoptimize.js';
import { assessRisk, operationalPriority } from '../services/riskAssessment.js';

const router = Router();
const ACTIVE = sqlList(ACTIVE_INCIDENT_STATUSES);
const isStaff = (role: string) => role === 'admin' || role === 'coordinator';

export function parseReportedAt(value: unknown): Date {
  if (typeof value !== 'string') return new Date();
  const d = new Date(value);
  const now = Date.now();
  if (Number.isNaN(d.getTime()) || d.getTime() > now + 5 * 60_000 || d.getTime() < now - 7 * 24 * 3600_000) return new Date();
  return d;
}

export function parseReportBody(body: Record<string, unknown>) {
  const clientId = optionalString(body.client_id, 'client_id', 64);
  if (clientId && !/^[A-Za-z0-9-]{8,64}$/.test(clientId)) throw new ValidationError('client_id is malformed');
  return {
    rawMessage: requiredString(body.raw_message, 'Report message', 5000),
    source: optionalString(body.source, 'source', 30) ?? 'manual',
    reporterName: optionalString(body.reporter_name, 'Reporter name', 100),
    reporterPhone: optionalString(body.reporter_phone, 'Reporter phone', 30),
    clientId,
    reporterLocation: latLng(body.reporter_lat, body.reporter_lng, 'reporter location'),
    /** Optional GPS accuracy in metres (browser Geolocation coords.accuracy). */
    reporterAccuracy: optionalNumber(body.reporter_accuracy, 'reporter_accuracy', 0, 100_000),
    reportedAt: parseReportedAt(body.reported_at),
  };
}

router.get('/', route('Failed to fetch reports', async (req, res) => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (!isStaff(req.user!.role)) {
    params.push(req.user!.id);
    conditions.push(`submitted_by = $${params.length}`);
  }
  if (req.query.incident_id) {
    params.push(String(req.query.incident_id));
    conditions.push(`incident_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  res.json(await getDb().query(`SELECT * FROM reports ${where} ORDER BY created_at DESC LIMIT 200`, params));
}));

router.get('/:id', route('Failed to fetch report', async (req, res) => {
  const report = await getDb().one('SELECT * FROM reports WHERE id = $1', [req.params.id]);
  if (!report || (!isStaff(req.user!.role) && report.submitted_by !== req.user!.id)) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  res.json(report);
}));

export type ParsedReportFields = ReturnType<typeof parseReportBody>;

/** Result for a report already received with this client_id (offline-queue retries, double submits). */
export async function existingReportResult(clientId: string | null) {
  const found = await findReportByClientId(getDb(), clientId);
  if (!found) return null;
  return {
    status: 'accepted' as const,
    already_processed: true,
    report: { id: found.report.id },
    incident: found.incident ?? undefined,
    classification: found.report.extracted_data ?? null,
    is_duplicate: !!found.report.is_duplicate,
    dedup: found.report.dedup ?? null,
    impact: [],
  };
}

class ReplayedReport extends Error {}

/** Shared by the signed-in /api/reports route and the public /api/public/reports route. */
export async function createReportFromMessage(
  fields: ParsedReportFields,
  classification: ClassificationResult,
  location: ResolvedLocation,
  submittedBy: string | null,
) {
  const replay = await existingReportResult(fields.clientId);
  if (replay) return replay;

  const db = getDb();
  const reportId = uuidv4();
  const signal: DedupSignal = {
    type: classification.type, lat: location.lat, lng: location.lng, location_meta: location.meta,
    location_source: location.source, place: location.meta.structured.place ?? location.name,
    text: fields.rawMessage, evidence: classification.evidence, reported_at: fields.reportedAt,
    gps: fields.reporterLocation,
  };

  let result: {
    incident: Record<string, unknown>; isDuplicate: boolean; impact: unknown[]; decision: DedupDecision;
    riskChanged: boolean; demandChanged: boolean;
  };
  try {
    result = await db.transaction(async (tx) => {
      // Serialize duplicate detection + creation so simultaneous reports of one event cannot both
      // create an incident: the second one sees the first inside this lock.
      await tx.query('SELECT pg_advisory_xact_lock(7224002)');
      if (fields.clientId && (await tx.one('SELECT id FROM reports WHERE client_id = $1', [fields.clientId]))) throw new ReplayedReport();

      // A placeholder pin (no usable location) never takes part in duplicate detection.
      const candidates = location.meta.precision === 'unverified' && location.meta.source === 'city_centre'
        ? [] : await loadDedupCandidates(tx, signal);
      const decision = decideDuplicate(signal, candidates);

      let incidentId: string;
      let incident: Record<string, unknown>;
      let riskChanged = false;
      let demandChanged = false;
      if (decision.decision === 'merge') {
        incidentId = decision.target!.incident_id;
        const merged = await mergeIntoIncident(tx, incidentId, {
          evidence: classification.evidence, people_affected: classification.people_affected, injuries: classification.injuries,
          has_children: classification.has_children, has_elderly: classification.has_elderly, has_disabled: classification.has_disabled,
          urgency_indicators: classification.urgency_indicators, reported_at: fields.reportedAt, reports_added: 1,
          location: { lat: location.lat, lng: location.lng, name: location.name, source: location.source, meta: location.meta },
        }, { report_id: reportId, score: decision.target!.score, reasons: decision.target!.reasons });
        incident = merged.incident;
        riskChanged = merged.riskChanged;
        demandChanged = merged.demandChanged;
      } else {
        const assessment = assessRisk(classification.evidence, classification.classifier);
        const { priority, priority_score: priorityScore } = operationalPriority(assessment);
        incidentId = uuidv4();
        const review = decision.decision === 'review'
          ? {
            status: 'pending', created_at: new Date().toISOString(), report_id: reportId,
            candidates: decision.scores.filter((x) => x.decision !== 'new').slice(0, 3)
              .map((x) => ({ incident_id: x.incident_id, score: x.score, reasons: x.reasons, components: x.components })),
          }
          : null;
        incident = (await tx.one(
          `INSERT INTO incidents (id, type, status, priority, priority_score, title, description, raw_message, language,
             location_lat, location_lng, location_name, people_affected, injuries, has_children, has_elderly, has_disabled,
             urgency_indicators, confidence, affected_radius_m, escalation_deadline, location_source, risk_assessment,
             location_meta, last_report_at, dedup_review)
           VALUES ($1, $2, 'triage', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
             now() + make_interval(mins => $20::int), $21, $22, $23, $24, $25)
           RETURNING *`,
          [
            incidentId, classification.type, priority, priorityScore,
            classification.title, classification.description, fields.rawMessage, classification.language,
            location.lat, location.lng, location.name,
            classification.people_affected, classification.injuries,
            classification.has_children, classification.has_elderly, classification.has_disabled,
            JSON.stringify(classification.urgency_indicators), classification.confidence,
            DEFAULT_RADIUS_M[classification.type], ESCALATION_THRESHOLD_MIN[classification.type],
            location.source, JSON.stringify(assessment), JSON.stringify(location.meta), fields.reportedAt,
            review ? JSON.stringify(review) : null,
          ],
        ))!;
        await audit(tx, {
          entityType: 'incident', entityId: incidentId, incidentId, action: 'created_from_report',
          details: {
            classifier: classification.classifier, type: classification.type, priority, report_id: reportId,
            risk_model: assessment.status === 'ok'
              ? { class: assessment.model_class, score: assessment.model_score, version: assessment.model_version }
              : 'unavailable',
            location_source: location.source, location_precision: location.meta.precision, location_confidence: location.meta.confidence,
          },
        });
        if (review) {
          await audit(tx, { entityType: 'incident', entityId: incidentId, incidentId, action: 'possible_duplicate', details: review });
        }
      }

      await tx.query(
        `INSERT INTO reports (id, client_id, incident_id, raw_message, language, source, reporter_name, reporter_phone,
           reporter_lat, reporter_lng, reporter_accuracy_m, submitted_by, extracted_data, classifier, confidence, is_duplicate,
           reported_at, location_meta, dedup)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          reportId, fields.clientId, incidentId, fields.rawMessage, classification.language, fields.source,
          fields.reporterName, fields.reporterPhone, fields.reporterLocation?.lat ?? null, fields.reporterLocation?.lng ?? null,
          fields.reporterAccuracy, submittedBy, JSON.stringify(classification), classification.classifier, classification.confidence,
          decision.decision === 'merge', fields.reportedAt, JSON.stringify(location.meta),
          JSON.stringify({
            decision: decision.decision, target_incident_id: decision.target?.incident_id ?? null, score: decision.target?.score ?? null,
            candidates: decision.scores.slice(0, 3).map((x) => ({ incident_id: x.incident_id, score: x.score, decision: x.decision, veto: x.veto, reasons: x.reasons })),
          }),
        ],
      );

      const resources = await tx.query('SELECT * FROM resources');
      const others = await tx.query(`SELECT * FROM incidents WHERE status IN (${ACTIVE}) AND parent_incident_id IS NULL AND id <> $1`, [incidentId]);
      const impact = propagateImpact(incident as never, others as never, resources as never);
      return { incident, isDuplicate: decision.decision === 'merge', impact, decision, riskChanged, demandChanged };
    });
  } catch (err) {
    // Same client_id submitted concurrently or retried: answer with what was already recorded.
    const unique = (err as { code?: string }).code === '23505' && String((err as Error).message).includes('client_id');
    if (err instanceof ReplayedReport || unique) {
      const again = await existingReportResult(fields.clientId);
      if (again) return again;
    }
    throw err;
  }

  broadcast('incident', 'upsert', result.incident);
  const incidentId = result.incident.id as string;
  if (!result.isDuplicate) reoptimize('incident_created', incidentId);
  else if (result.riskChanged || result.demandChanged) reoptimize('incident_merged', incidentId);
  const newPriority = result.incident.priority as string;
  if (!result.isDuplicate && (newPriority === 'critical' || newPriority === 'high')) {
    await notify({
      type: newPriority === 'critical' ? 'critical' : 'warning',
      title: `New ${newPriority} incident: ${classification.title}`,
      message: location.name ?? 'Location unknown',
      incidentId,
    });
  }
  if (result.decision.decision === 'review') {
    await notify({
      type: 'warning',
      title: 'Possible duplicate incident',
      message: `"${classification.title}" may be the same event as an existing incident (score ${result.decision.target?.score}). Review before dispatching twice.`,
      incidentId,
    });
  }

  return {
    status: 'accepted' as const,
    report: { id: reportId },
    incident: result.incident,
    classification,
    is_duplicate: result.isDuplicate,
    dedup: { decision: result.decision.decision, target_incident_id: result.decision.target?.incident_id ?? null, score: result.decision.target?.score ?? null },
    location: { precision: location.meta.precision, confidence: location.meta.confidence, needs_verification: location.meta.needs_verification },
    impact: result.impact,
  };
}

export function reporterFix(fields: ParsedReportFields) {
  return fields.reporterLocation ? { ...fields.reporterLocation, accuracy_m: fields.reporterAccuracy } : null;
}

router.post('/', route('Failed to process report', async (req, res) => {
  const fields = parseReportBody(req.body ?? {});
  const replay = await existingReportResult(fields.clientId);
  if (replay) {
    res.status(200).json(replay);
    return;
  }
  const classification = await classifyReport(fields.rawMessage);
  const location = await resolveLocation(classification, fields.rawMessage, reporterFix(fields));
  const result = await createReportFromMessage(fields, classification, location, req.user!.id);
  res.status(result.is_duplicate || 'already_processed' in result ? 200 : 201).json(result);
}));

export default router;
