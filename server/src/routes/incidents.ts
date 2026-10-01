import { Router } from 'express';
import { getDb } from '../db.js';
import { requireRole } from '../auth.js';
import { route } from '../http.js';
import {
  ACTIVE_INCIDENT_STATUSES, INCIDENT_STATUSES, INCIDENT_TYPES,
  PRIORITIES, isOneOf, sqlList,
} from '../constants.js';
import {
  latLng, optionalEnum, optionalInt, optionalString, requiredString, ValidationError,
} from '../validate.js';
import { audit } from '../services/audit.js';
import { transitionIncident, INCIDENT_TRANSITIONS, WorkflowError } from '../services/workflow.js';
import { propagateImpact } from '../services/impactPropagation.js';
import { broadcast } from '../realtime.js';
import { reoptimize } from '../services/allocation/reoptimize.js';
import { ASSIGNMENT_SELECT, ChangeSet } from '../rows.js';
import { FREED_STATUS_SQL } from '../services/allocation/approval.js';
import { notify } from '../services/notify.js';
import type { LocationMeta } from '../services/locate.js';
import { decideDuplicate } from '../services/deduplication.js';
import { loadDedupCandidates, mergeIntoIncident, signalForIncident } from '../services/incidentMerge.js';
import { incidentEvidence } from '../services/riskAssessment.js';
import { buildIncidentDemand } from '../services/allocation/demand.js';

const router = Router();
const ACTIVE = sqlList(ACTIVE_INCIDENT_STATUSES);
const staff = requireRole('admin', 'coordinator');

router.get('/stats', route('Failed to fetch stats', async (_req, res) => {
  const db = getDb();
  const totals = await db.one(
    `SELECT COUNT(*)::int AS active_count,
            COALESCE(SUM(people_affected), 0)::int AS total_people_affected,
            COALESCE(SUM(injuries), 0)::int AS total_injuries
     FROM incidents WHERE status IN (${ACTIVE}) AND parent_incident_id IS NULL`,
  );
  const byType = await db.query(
    `SELECT type, COUNT(*)::int AS count FROM incidents WHERE status IN (${ACTIVE}) AND parent_incident_id IS NULL GROUP BY type`,
  );
  const byPriority = await db.query(
    `SELECT priority, COUNT(*)::int AS count FROM incidents WHERE status IN (${ACTIVE}) AND parent_incident_id IS NULL GROUP BY priority`,
  );
  const byStatus = await db.query(
    'SELECT status, COUNT(*)::int AS count FROM incidents WHERE parent_incident_id IS NULL GROUP BY status',
  );
  res.json({ ...totals, by_type: byType, by_priority: byPriority, by_status: byStatus });
}));

router.get('/', route('Failed to fetch incidents', async (req, res) => {
  const conditions = ['parent_incident_id IS NULL'];
  const params: unknown[] = [];
  const status = req.query.status;
  if (status === 'active') {
    conditions.push(`status IN (${ACTIVE})`);
  } else if (status && status !== 'all') {
    params.push(optionalEnum(status, 'status', INCIDENT_STATUSES));
    conditions.push(`status = $${params.length}`);
  } else if (status !== 'all') {
    conditions.push(`(status IN (${ACTIVE}) OR updated_at > now() - interval '30 days')`);
  }
  if (req.query.type) {
    params.push(optionalEnum(req.query.type, 'type', INCIDENT_TYPES));
    conditions.push(`type = $${params.length}`);
  }
  if (req.query.priority) {
    params.push(optionalEnum(req.query.priority, 'priority', PRIORITIES));
    conditions.push(`priority = $${params.length}`);
  }
  const incidents = await getDb().query(
    `SELECT * FROM incidents WHERE ${conditions.join(' AND ')} ORDER BY priority_score DESC, created_at DESC LIMIT 1000`,
    params,
  );
  res.json(incidents);
}));

router.get('/:id', route('Failed to fetch incident', async (req, res) => {
  const db = getDb();
  const incident = await db.one('SELECT * FROM incidents WHERE id = $1', [req.params.id]);
  if (!incident) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const staffView = req.user!.role !== 'field_reporter';
  const [reports, assignments, blockedRoads, merged, review, others, resources] = await Promise.all([
    staffView ? db.query(`SELECT * FROM reports WHERE incident_id = $1 ORDER BY created_at DESC`, [incident.id]) : Promise.resolve([]),
    db.query(`${ASSIGNMENT_SELECT} WHERE ra.incident_id = $1 ORDER BY ra.ai_score DESC NULLS LAST`, [incident.id]),
    db.query('SELECT * FROM blocked_roads WHERE incident_id = $1', [incident.id]),
    db.query('SELECT * FROM incidents WHERE parent_incident_id = $1', [incident.id]),
    db.one('SELECT * FROM incident_reviews WHERE incident_id = $1', [incident.id]),
    db.query(`SELECT * FROM incidents WHERE status IN (${ACTIVE}) AND parent_incident_id IS NULL AND id <> $1`, [incident.id]),
    db.query('SELECT * FROM resources'),
  ]);
  res.json({
    ...incident,
    reports,
    assignments,
    blocked_roads: blockedRoads,
    merged_incidents: merged,
    review: review ?? null,
    impact: propagateImpact(incident as never, others as never, resources as never),
    allowed_transitions: INCIDENT_TRANSITIONS[incident.status as keyof typeof INCIDENT_TRANSITIONS] ?? [],
  });
}));

// Read-only view of the incident's resource requirements, built by the same demand model the
// optimizer uses. Creates no proposals and changes nothing.
router.get('/:id/demand', staff, route('Failed to fetch incident demand', async (req, res) => {
  const incident = await getDb().one('SELECT * FROM incidents WHERE id = $1', [req.params.id]);
  if (!incident) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const demand = buildIncidentDemand(incident as never);
  res.json({ incident_id: demand.incident_id, slots: demand.slots, shelter_need: demand.shelter_need });
}));

router.get('/:id/timeline', staff, route('Failed to fetch timeline', async (req, res) => {
  const entries = await getDb().query(
    'SELECT * FROM audit_log WHERE incident_id = $1 ORDER BY created_at ASC LIMIT 500',
    [req.params.id],
  );
  res.json(entries);
}));

router.post('/:id/transition', staff, route('Failed to change incident status', async (req, res) => {
  const to = optionalEnum(req.body.to, 'to', INCIDENT_STATUSES);
  if (!to) throw new ValidationError('Target status ("to") is required');
  const note = optionalString(req.body.note, 'note', 2000);
  const review = to === 'closed'
    ? {
      summary: requiredString(req.body.review?.summary, 'Review summary', 5000),
      went_well: optionalString(req.body.review?.went_well, 'What went well', 5000),
      improvements: optionalString(req.body.review?.improvements, 'Improvements', 5000),
    }
    : null;

  const db = getDb();
  const changes = new ChangeSet();
  const incident = await db.transaction((tx) => transitionIncident(tx, req.params.id as string, to, req.user!, changes, { note, review }));
  await changes.publish(db);
  reoptimize(to === 'resolved' || to === 'closed' ? 'incident_resolved' : 'coordinator_decision', req.params.id as string);
  res.json(incident);
}));

// ── Location verification / correction (staff) ────────────────────────────────
// action "verify": confirm the current location · "correct": set new coordinates ·
// "choose_candidate": adopt one of the geocoder candidates recorded at resolution time.
router.patch('/:id/location', staff, route('Failed to update incident location', async (req, res) => {
  const action = optionalEnum(req.body.action, 'action', ['verify', 'correct', 'choose_candidate'] as const);
  if (!action) throw new ValidationError('action must be verify, correct or choose_candidate');
  const note = optionalString(req.body.note, 'note', 1000);
  const db = getDb();
  const changes = new ChangeSet();
  const updated = await db.transaction(async (tx) => {
    const inc = await tx.one('SELECT * FROM incidents WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!inc) throw new WorkflowError('Incident not found', 404);
    if (!isOneOf(ACTIVE_INCIDENT_STATUSES, inc.status) || inc.parent_incident_id) throw new WorkflowError('This incident is no longer active');
    const old = (inc.location_meta ?? {}) as Partial<LocationMeta>;
    let lat = inc.location_lat as number;
    let lng = inc.location_lng as number;
    let name = inc.location_name as string | null;
    if (action === 'correct') {
      const p = latLng(req.body.lat, req.body.lng, 'location');
      if (!p) throw new ValidationError('lat and lng are required');
      ({ lat, lng } = p);
      name = optionalString(req.body.location_name, 'location_name', 200) ?? name;
    } else if (action === 'choose_candidate') {
      const idx = optionalInt(req.body.candidate_index, 'candidate_index', 0, 20);
      const c = idx === null ? undefined : old.candidates?.[idx];
      if (!c) throw new ValidationError('candidate_index does not match a recorded candidate');
      ({ lat, lng } = c);
      name = optionalString(req.body.location_name, 'location_name', 200) ?? name ?? c.name;
    }
    const meta: LocationMeta = {
      ...(old as LocationMeta),
      version: 1,
      precision: 'verified', confidence: 1, ambiguous: false, needs_verification: false,
      accuracy_m: action === 'verify' ? Math.min(old.accuracy_m ?? 100, 500) : 30,
      source: action === 'verify' ? (old.source ?? 'coordinator') : 'coordinator',
      notes: [...(old.notes ?? []), `${action} by coordinator${note ? `: ${note}` : ''}`],
      verified: { by: req.user!.id, at: new Date().toISOString(), action },
    };
    const source = inc.location_source === 'reporter_gps' && action === 'verify' ? 'reporter_gps' : 'geocoded';
    const row = (await tx.one(
      `UPDATE incidents SET location_lat = $2, location_lng = $3, location_name = $4, location_source = $5,
         location_meta = $6, updated_at = now() WHERE id = $1 RETURNING *`,
      [inc.id, lat, lng, name, source, JSON.stringify(meta)],
    ))!;
    await audit(tx, {
      entityType: 'incident', entityId: inc.id, incidentId: inc.id,
      action: action === 'verify' ? 'location_verified' : 'location_corrected', user: req.user,
      details: {
        action, note,
        from: { lat: inc.location_lat, lng: inc.location_lng, name: inc.location_name, source: inc.location_source, precision: old.precision ?? null },
        to: { lat, lng, name, source },
      },
    });

    // Re-check duplicates at the (possibly new) location. Two existing incidents are never merged
    // automatically: a likely match is flagged for the coordinator.
    const signal = await signalForIncident(tx, row);
    const decision = decideDuplicate(signal, await loadDedupCandidates(tx, signal, row.id));
    let final = row;
    if (decision.decision !== 'new') {
      const review = {
        status: 'pending', created_at: new Date().toISOString(), reason: 'location_change',
        candidates: decision.scores.filter((x) => x.decision !== 'new').slice(0, 3)
          .map((x) => ({ incident_id: x.incident_id, score: x.score, reasons: x.reasons, components: x.components })),
      };
      final = (await tx.one('UPDATE incidents SET dedup_review = $2 WHERE id = $1 RETURNING *', [row.id, JSON.stringify(review)]))!;
      await audit(tx, { entityType: 'incident', entityId: row.id, incidentId: row.id, action: 'possible_duplicate', user: req.user, details: review });
    }
    changes.incidents.add(row.id);
    return { row: final, dedup: decision.decision };
  });
  await changes.publish(db);
  if (updated.dedup !== 'new') {
    await notify({ type: 'warning', title: 'Possible duplicate after location change', message: `${updated.row.title ?? 'Incident'} may duplicate another incident. Review before dispatching twice.`, incidentId: updated.row.id });
  }
  reoptimize('incident_location_changed', updated.row.id);
  res.json({ ...updated.row, dedup_check: updated.dedup });
}));

// ── Coordinator decision on a flagged possible duplicate ──────────────────────
// "separate": keep both incidents · "merge": fold this incident into target_incident_id.
router.post('/:id/duplicate-review', staff, route('Failed to record duplicate decision', async (req, res) => {
  const decision = optionalEnum(req.body.decision, 'decision', ['merge', 'separate'] as const);
  if (!decision) throw new ValidationError('decision must be merge or separate');
  const db = getDb();
  const changes = new ChangeSet();
  const out = await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7224002)');
    const src = await tx.one('SELECT * FROM incidents WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!src) throw new WorkflowError('Incident not found', 404);
    const review = (src.dedup_review ?? {}) as Record<string, unknown>;
    if (decision === 'separate') {
      const row = (await tx.one('UPDATE incidents SET dedup_review = $2, updated_at = now() WHERE id = $1 RETURNING *', [
        src.id, JSON.stringify({ ...review, status: 'dismissed', decided_by: req.user!.id, decided_at: new Date().toISOString() }),
      ]))!;
      await audit(tx, { entityType: 'incident', entityId: src.id, incidentId: src.id, action: 'duplicate_dismissed', user: req.user, details: {} });
      changes.incidents.add(src.id);
      return { source: row, target: null };
    }

    const targetId = requiredString(req.body.target_incident_id, 'target_incident_id', 64);
    if (targetId === src.id) throw new ValidationError('An incident cannot be merged into itself');
    const target = await tx.one('SELECT * FROM incidents WHERE id = $1 FOR UPDATE', [targetId]);
    if (!target) throw new WorkflowError('Target incident not found', 404);
    for (const x of [src, target]) {
      if (!isOneOf(ACTIVE_INCIDENT_STATUSES, x.status) || x.parent_incident_id) throw new WorkflowError('Both incidents must be active and not already merged');
    }
    const active = await tx.one(`SELECT COUNT(*)::int AS n FROM resource_assignments WHERE incident_id = $1 AND status IN ('dispatched', 'en_route', 'arrived')`, [src.id]);
    if (active?.n) throw new WorkflowError('Units are assigned to this incident; release or reassign them before merging it', 409, 'incident_has_units');

    // Pending proposals for the absorbed incident are withdrawn; its reports move to the target.
    const withdrawn = await tx.query(`DELETE FROM resource_assignments WHERE incident_id = $1 AND status = 'recommended' RETURNING id`, [src.id]);
    for (const w of withdrawn) changes.deletedAssignments.add(w.id);
    const moved = await tx.query('UPDATE reports SET incident_id = $2, is_duplicate = true WHERE incident_id = $1 RETURNING id', [src.id, target.id]);
    const merged = await mergeIntoIncident(tx, target.id, {
      evidence: incidentEvidence(src), people_affected: src.people_affected, injuries: src.injuries,
      has_children: src.has_children, has_elderly: src.has_elderly, has_disabled: src.has_disabled,
      urgency_indicators: src.urgency_indicators ?? [], reported_at: new Date(src.last_report_at ?? src.created_at),
      reports_added: Math.max(1, moved.length),
      location: { lat: src.location_lat, lng: src.location_lng, name: src.location_name, source: src.location_source, meta: src.location_meta },
    }, { merged_incident_id: src.id, reasons: ['coordinator confirmed duplicate'], user: req.user });
    // The absorbed incident points at the canonical one; citizen tracking follows the parent.
    const srcRow = (await tx.one(
      `UPDATE incidents SET parent_incident_id = $2, status = 'resolved', resolved_at = now(), escalation_deadline = NULL,
         dedup_review = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [src.id, target.id, JSON.stringify({ ...review, status: 'merged', target_incident_id: target.id, decided_by: req.user!.id, decided_at: new Date().toISOString() })],
    ))!;
    await audit(tx, { entityType: 'incident', entityId: src.id, incidentId: src.id, action: 'merged_into', user: req.user, details: { target_incident_id: target.id, reports_moved: moved.length } });
    changes.incidents.add(src.id);
    changes.incidents.add(target.id);
    return { source: srcRow, target: merged.incident };
  });
  await changes.publish(db);
  reoptimize('duplicate_review', out.source.id);
  res.json(out);
}));

router.delete('/:id', requireRole('admin'), route('Failed to delete incident', async (req, res) => {
  const db = getDb();
  const changes = new ChangeSet();
  const deleted = await db.transaction(async (tx) => {
    const freed = await tx.query(
      `UPDATE resources SET status = ${FREED_STATUS_SQL}, assigned_incident_id = NULL, eta_minutes = NULL, updated_at = now()
       WHERE assigned_incident_id = $1 RETURNING id`,
      [req.params.id],
    );
    for (const r of freed) changes.resources.add(r.id);
    const row = await tx.one('DELETE FROM incidents WHERE id = $1 RETURNING *', [req.params.id]);
    if (!row) return null;
    await audit(tx, { entityType: 'incident', entityId: row.id, incidentId: row.id, action: 'deleted', user: req.user, details: { title: row.title, type: row.type } });
    return row;
  });
  if (!deleted) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  broadcast('incident', 'delete', { id: deleted.id });
  await changes.publish(db);
  reoptimize('incident_deleted', deleted.id);
  res.json({ ok: true });
}));

export default router;
