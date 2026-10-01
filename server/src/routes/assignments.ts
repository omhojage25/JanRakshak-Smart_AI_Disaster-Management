import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { requireRole } from '../auth.js';
import { route } from '../http.js';
import { ACTIVE_INCIDENT_STATUSES, ASSIGNMENT_STATUSES, isOneOf } from '../constants.js';
import { optionalEnum, optionalString, requiredString, ValidationError } from '../validate.js';
import { runExclusive, reoptimize } from '../services/allocation/reoptimize.js';
import { describeProposal } from '../services/allocation/allocationRun.js';
import { transitionAssignment, WorkflowError } from '../services/workflow.js';
import { audit } from '../services/audit.js';
import { ASSIGNMENT_SELECT, ChangeSet } from '../rows.js';

const router = Router();
const staff = requireRole('admin', 'coordinator');
const FIELD_ALLOWED: string[] = ['en_route', 'arrived'];

router.get('/', route('Failed to fetch assignments', async (req, res) => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(`${sql} = $${params.length}`);
  };
  if (req.query.incident_id) add('ra.incident_id', String(req.query.incident_id));
  if (req.query.resource_id) add('ra.resource_id', String(req.query.resource_id));
  if (req.query.status) add('ra.status', optionalEnum(req.query.status, 'status', ASSIGNMENT_STATUSES));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await getDb().query(`${ASSIGNMENT_SELECT} ${where} ORDER BY ra.created_at DESC LIMIT 1000`, params);
  res.json(rows);
}));

router.post('/', staff, route('Failed to create assignment', async (req, res) => {
  const incidentId = requiredString(req.body.incident_id, 'incident_id', 64);
  const resourceId = requiredString(req.body.resource_id, 'resource_id', 64);
  const db = getDb();
  const changes = new ChangeSet();
  const id = uuidv4();
  await db.transaction(async (tx) => {
    const incident = await tx.one('SELECT id, status FROM incidents WHERE id = $1', [incidentId]);
    if (!incident) throw new WorkflowError('Incident not found', 404);
    if (!isOneOf(ACTIVE_INCIDENT_STATUSES, incident.status)) throw new WorkflowError('This incident is no longer active');
    const resource = await tx.one('SELECT id, name FROM resources WHERE id = $1', [resourceId]);
    if (!resource) throw new WorkflowError('Resource not found', 404);
    const duplicate = await tx.one(
      `SELECT id FROM resource_assignments WHERE incident_id = $1 AND resource_id = $2 AND status IN ('recommended', 'dispatched', 'en_route', 'arrived')`,
      [incidentId, resourceId],
    );
    if (duplicate) throw new WorkflowError(`${resource.name} is already assigned to this incident`);
    await tx.query(
      `INSERT INTO resource_assignments (id, incident_id, resource_id, status, coordinator_notes) VALUES ($1, $2, $3, 'recommended', $4)`,
      [id, incidentId, resourceId, optionalString(req.body.coordinator_notes, 'notes', 2000)],
    );
    await audit(tx, { entityType: 'assignment', entityId: id, incidentId, action: 'created', user: req.user, details: { resource_name: resource.name, manual: true } });
    changes.assignments.add(id);
    if (req.body.dispatch === true) {
      await transitionAssignment(tx, id, 'dispatched', req.user!, changes, { force: req.body.force === true });
    }
  });
  await changes.publish(db);
  reoptimize('coordinator_decision');
  res.status(201).json(await db.one(`${ASSIGNMENT_SELECT} WHERE ra.id = $1`, [id]));
}));

router.patch('/:id', route('Failed to update assignment', async (req, res) => {
  const to = optionalEnum(req.body.status, 'status', ASSIGNMENT_STATUSES);
  const notes = optionalString(req.body.coordinator_notes, 'notes', 2000);
  const db = getDb();
  const assignment = await db.one('SELECT * FROM resource_assignments WHERE id = $1', [req.params.id]);
  if (!assignment) {
    res.status(404).json({ error: 'Assignment not found' });
    return;
  }

  const user = req.user!;
  if (user.role === 'field_reporter') {
    const ownUnit = user.resource_id && user.resource_id === assignment.resource_id;
    if (!ownUnit || !to || !FIELD_ALLOWED.includes(to)) {
      res.status(403).json({ error: 'Field units can only update the status of their own assignment' });
      return;
    }
  }
  if (!to && notes === null) throw new ValidationError('Nothing to update');

  const changes = new ChangeSet();
  await db.transaction(async (tx) => {
    if (to) {
      await transitionAssignment(tx, assignment.id, to, user, changes, { notes, force: req.body.force === true });
    } else {
      await tx.query('UPDATE resource_assignments SET coordinator_notes = $1, updated_at = now() WHERE id = $2', [notes, assignment.id]);
      changes.assignments.add(assignment.id);
    }
  });
  await changes.publish(db);
  if (to) reoptimize(to === 'completed' || to === 'rejected' ? 'resource_freed' : 'coordinator_decision');
  res.json(await db.one(`${ASSIGNMENT_SELECT} WHERE ra.id = $1`, [assignment.id]));
}));

// Mounted at /api, so the full path is /api/incidents/:id/recommend.
export const recommendRouter = Router();

recommendRouter.post('/incidents/:id/recommend', staff, route('Failed to generate recommendations', async (req, res) => {
  const incidentId = req.params.id as string;
  const incident = await getDb().one('SELECT id, status, parent_incident_id FROM incidents WHERE id = $1', [incidentId]);
  if (!incident) throw new WorkflowError('Incident not found', 404);
  if (!isOneOf(ACTIVE_INCIDENT_STATUSES, incident.status) || incident.parent_incident_id) throw new WorkflowError('This incident is no longer active');

  // Global optimization across ALL active incidents; this incident's slice is returned.
  const { plan, rowIds } = await runExclusive({ trigger: 'manual_recommend', allowMoves: true, focusIncidentId: incidentId });
  if (plan.degraded) {
    throw new WorkflowError(`${plan.degraded_reason}. No allocation recommendations until routing recovers; assign units manually if needed.`, 503, 'routing_unavailable');
  }
  const mine = plan.proposals.filter((p) => p.incident_id === incidentId);
  res.json({
    incident_id: incidentId,
    run_id: plan.run_id,
    degraded: plan.degraded,
    recommendations: mine.map((p) => ({
      assignment_id: rowIds.get(p.key) ?? null, resource_id: p.resource_id, resource_name: p.resource_name,
      resource_type: p.slot.resource_type, kind: p.kind, slot: p.slot.id, score: p.utility.net, eta_minutes: p.eta_min,
      reasoning: describeProposal(p, plan.run_id),
    })),
    slots: plan.slots.filter((o) => o.slot.incident_id === incidentId)
      .map((o) => ({ slot: o.slot.id, status: o.status, resource_id: o.resource_id ?? null, reason: o.reason ?? null })),
    plan: { mode: plan.mode, objective: plan.objective, stats: plan.stats, warnings: plan.warnings },
  });
}));

export default router;
