import { v4 as uuidv4 } from 'uuid';
import type { Queryable, Row } from '../db.js';
import type { AuthUser } from '../auth.js';
import {
  ACTIVE_INCIDENT_STATUSES, ESCALATION_THRESHOLD_MIN, isOneOf,
  type AssignmentStatus, type IncidentStatus, type IncidentType, type ResourceStatus,
} from '../constants.js';
import { audit } from './audit.js';
import type { ChangeSet } from '../rows.js';
import {
  FREED_STATUS_SQL, applyTransportLoad, closeReplacedAssignment, validateProposalAtApproval,
} from './allocation/approval.js';

export class WorkflowError extends Error {
  constructor(message: string, public status = 409, public code?: string) {
    super(message);
  }
}

export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  triage: ['dispatched', 'resolved'],
  dispatched: ['on_scene', 'resolved'],
  on_scene: ['contained', 'resolved'],
  contained: ['on_scene', 'resolved'],
  resolved: ['closed', 'triage'],
  closed: [],
};

export const ASSIGNMENT_TRANSITIONS: Record<AssignmentStatus, AssignmentStatus[]> = {
  recommended: ['dispatched', 'rejected'],
  dispatched: ['en_route', 'arrived', 'completed', 'rejected'],
  en_route: ['arrived', 'completed', 'rejected'],
  arrived: ['completed'],
  completed: [],
  rejected: [],
};

const ACTIVE_ASSIGNMENT = ['dispatched', 'en_route', 'arrived'];

const RESOURCE_STATUS_FOR: Partial<Record<AssignmentStatus, ResourceStatus>> = {
  dispatched: 'dispatched',
  en_route: 'en_route',
  arrived: 'on_scene',
};

const label = (s: string) => s.replace(/_/g, ' ');

export interface ReviewInput {
  summary: string;
  went_well: string | null;
  improvements: string | null;
}

export async function transitionIncident(
  tx: Queryable,
  incidentId: string,
  to: IncidentStatus,
  user: AuthUser | null,
  changes: ChangeSet,
  opts: { note?: string | null; review?: ReviewInput | null; automatic?: boolean } = {},
): Promise<Row> {
  const incident = await tx.one('SELECT * FROM incidents WHERE id = $1 FOR UPDATE', [incidentId]);
  if (!incident) throw new WorkflowError('Incident not found', 404);
  const from = incident.status as IncidentStatus;
  if (from === to) return incident;
  if (!INCIDENT_TRANSITIONS[from]?.includes(to)) {
    throw new WorkflowError(`An incident cannot move from "${label(from)}" to "${label(to)}"`);
  }

  if (to === 'dispatched') {
    const active = await tx.one<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM resource_assignments WHERE incident_id = $1 AND status IN ('dispatched', 'en_route', 'arrived')`,
      [incidentId],
    );
    if (!active?.count) throw new WorkflowError('Dispatch at least one resource before marking the incident as dispatched');
  }
  if (to === 'closed' && !opts.review?.summary) {
    throw new WorkflowError('A post-incident review summary is required to close an incident', 400);
  }

  const threshold = ESCALATION_THRESHOLD_MIN[incident.type as IncidentType] ?? 45;
  const statusSql: Record<IncidentStatus, string> = {
    triage: 'resolved_at = NULL, escalation_deadline = now() + make_interval(mins => $3::int)',
    dispatched: 'escalation_deadline = now() + make_interval(mins => $3::int)',
    on_scene: 'escalation_deadline = NULL',
    contained: 'escalation_deadline = NULL',
    resolved: 'resolved_at = now(), escalation_deadline = NULL',
    closed: 'closed_at = now()',
  };
  const needsThreshold = to === 'triage' || to === 'dispatched';
  await tx.query(
    `UPDATE incidents SET status = $1, updated_at = now(), ${statusSql[to]} WHERE id = $2`,
    needsThreshold ? [to, incidentId, threshold] : [to, incidentId],
  );

  if (to === 'resolved') {
    const open = await tx.query(
      `SELECT * FROM resource_assignments WHERE incident_id = $1 AND status IN ('recommended', 'dispatched', 'en_route', 'arrived')`,
      [incidentId],
    );
    for (const a of open) {
      if (a.status === 'recommended') {
        await tx.query(
          `UPDATE resource_assignments SET status = 'rejected', coordinator_action = 'closed_with_incident', updated_at = now() WHERE id = $1`,
          [a.id],
        );
      } else {
        await tx.query(`UPDATE resource_assignments SET status = 'completed', updated_at = now() WHERE id = $1`, [a.id]);
        await applyTransportLoad(tx, a, a.status, 'completed', changes);
      }
      changes.assignments.add(a.id);
    }
    const freed = await tx.query(
      `UPDATE resources SET status = ${FREED_STATUS_SQL}, assigned_incident_id = NULL, eta_minutes = NULL, updated_at = now()
       WHERE assigned_incident_id = $1 RETURNING id`,
      [incidentId],
    );
    for (const r of freed) changes.resources.add(r.id);
  }

  if (to === 'closed' && opts.review) {
    await tx.query(
      `INSERT INTO incident_reviews (id, incident_id, reviewer_id, reviewer_name, summary, went_well, improvements)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv4(), incidentId, user?.id ?? null, user?.full_name ?? null, opts.review.summary, opts.review.went_well, opts.review.improvements],
    );
  }

  await audit(tx, {
    entityType: 'incident',
    entityId: incidentId,
    incidentId,
    action: 'status_changed',
    user,
    details: { from, to, note: opts.note ?? undefined, automatic: opts.automatic || undefined },
  });
  changes.incidents.add(incidentId);
  return (await tx.one('SELECT * FROM incidents WHERE id = $1', [incidentId]))!;
}

export async function transitionAssignment(
  tx: Queryable,
  assignmentId: string,
  to: AssignmentStatus,
  user: AuthUser,
  changes: ChangeSet,
  opts: { notes?: string | null; force?: boolean } = {},
): Promise<void> {
  const a = await tx.one('SELECT * FROM resource_assignments WHERE id = $1 FOR UPDATE', [assignmentId]);
  if (!a) throw new WorkflowError('Assignment not found', 404);
  const from = a.status as AssignmentStatus;
  if (from === to) return;
  if (!ASSIGNMENT_TRANSITIONS[from].includes(to)) {
    throw new WorkflowError(`An assignment cannot move from "${label(from)}" to "${label(to)}"`);
  }

  const resource = await tx.one('SELECT * FROM resources WHERE id = $1 FOR UPDATE', [a.resource_id]);
  const incident = await tx.one('SELECT * FROM incidents WHERE id = $1', [a.incident_id]);
  if (!resource || !incident) throw new WorkflowError('Assignment refers to a missing resource or incident', 404);

  if (to === 'dispatched') {
    if (!isOneOf(ACTIVE_INCIDENT_STATUSES, incident.status)) {
      throw new WorkflowError('This incident is no longer active');
    }
    if (resource.status === 'unavailable') {
      throw new WorkflowError(`${resource.name} is marked unavailable`);
    }
    if (from === 'recommended') await validateProposalAtApproval(tx, a, resource);
    const busyElsewhere = resource.assigned_incident_id
      && resource.assigned_incident_id !== a.incident_id
      && resource.status !== 'available';
    if (busyElsewhere && !opts.force) {
      throw new WorkflowError(`${resource.name} is already committed to another incident`, 409, 'resource_busy');
    }
    if (busyElsewhere) {
      const others = await tx.query(
        `UPDATE resource_assignments SET status = 'rejected', coordinator_action = 'reassigned', updated_at = now()
         WHERE resource_id = $1 AND incident_id <> $2 AND status IN ('dispatched', 'en_route', 'arrived') RETURNING id`,
        [resource.id, a.incident_id],
      );
      for (const o of others) changes.assignments.add(o.id);
      await audit(tx, {
        entityType: 'resource', entityId: resource.id, incidentId: resource.assigned_incident_id,
        action: 'reassigned', user, details: { resource_name: resource.name, to_incident: a.incident_id },
      });
    }
  }

  const coordinatorDecision = (from === 'recommended' && to === 'dispatched') || to === 'rejected';
  const coordinatorAction = from === 'recommended' && to === 'dispatched'
    ? 'approved'
    : to === 'rejected' ? (from === 'recommended' ? 'rejected' : 'cancelled') : a.coordinator_action;

  await tx.query(
    `UPDATE resource_assignments
     SET status = $1, coordinator_action = $2, coordinator_notes = COALESCE($3, coordinator_notes),
         decided_by = COALESCE($4, decided_by), updated_at = now()
     WHERE id = $5`,
    [to, coordinatorAction, opts.notes ?? null, coordinatorDecision ? user.id : null, assignmentId],
  );
  changes.assignments.add(assignmentId);

  const resourceStatus = RESOURCE_STATUS_FOR[to];
  if (resourceStatus) {
    await tx.query(
      `UPDATE resources SET status = $1, assigned_incident_id = $2, eta_minutes = $3, updated_at = now() WHERE id = $4`,
      [resourceStatus, a.incident_id, to === 'arrived' ? null : a.eta_minutes, resource.id],
    );
    changes.resources.add(resource.id);
  } else if (ACTIVE_ASSIGNMENT.includes(from) && resource.assigned_incident_id === a.incident_id) {
    await tx.query(
      `UPDATE resources SET status = ${FREED_STATUS_SQL}, assigned_incident_id = NULL, eta_minutes = NULL, updated_at = now() WHERE id = $1`,
      [resource.id],
    );
    changes.resources.add(resource.id);
  }
  await applyTransportLoad(tx, a, from, to, changes);
  if (from === 'recommended' && to === 'dispatched') await closeReplacedAssignment(tx, a, user, changes);

  await audit(tx, {
    entityType: 'assignment',
    entityId: assignmentId,
    incidentId: a.incident_id,
    action: from === 'recommended' && to === 'dispatched' ? 'approved' : to,
    user,
    details: { resource_name: resource.name, from, to, notes: opts.notes ?? undefined },
  });

  if ((to === 'dispatched' || to === 'en_route') && incident.status === 'triage') {
    await transitionIncident(tx, incident.id, 'dispatched', user, changes, { automatic: true });
  }
  if (to === 'arrived') {
    if (incident.status === 'triage') {
      await transitionIncident(tx, incident.id, 'dispatched', user, changes, { automatic: true });
    }
    if (incident.status === 'triage' || incident.status === 'dispatched') {
      await transitionIncident(tx, incident.id, 'on_scene', user, changes, { automatic: true });
    }
  }
}
