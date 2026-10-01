/**
 * Transaction-time checks and side effects for approving optimizer proposals, plus the MVP
 * capacity model. Called from workflow.transitionAssignment inside the approval transaction.
 */
import type { Queryable, Row } from '../../db.js';
import type { AuthUser } from '../../auth.js';
import type { ChangeSet } from '../../rows.js';
import { audit } from '../audit.js';
import { blockedRoadsVersion } from '../routing.js';
import type { AllocationMeta } from './allocationRun.js';

class ApprovalConflict extends Error {
  constructor(message: string, public status = 409, public code = 'allocation_stale') {
    super(message);
  }
}

/** SQL fragment: freeing a unit never overrides an explicit "unavailable". */
export const FREED_STATUS_SQL = `CASE WHEN status = 'unavailable' THEN 'unavailable' ELSE 'available' END`;

/**
 * Re-validates an optimizer proposal against the current state, inside the approval transaction.
 * Throws a 409 when the world changed since the plan (the coordinator should refresh).
 */
export async function validateProposalAtApproval(tx: Queryable, a: Row, resource: Row): Promise<void> {
  const meta = a.allocation as AllocationMeta | null;
  if (!meta) return;
  const stale = (why: string) => new ApprovalConflict(`This recommendation is out of date: ${why}. Refresh recommendations.`);

  const caps: string[] = Array.isArray(resource.capabilities) ? resource.capabilities : [];
  const missing = meta.slot.required_caps.filter((c) => !caps.includes(c));
  if (missing.length) throw stale(`${resource.name} no longer has ${missing.join(', ')}`);
  if (meta.slot.capacity_need > 0 && resource.capacity - resource.current_load < meta.slot.capacity_need) {
    throw stale(`${resource.name} no longer has ${meta.slot.capacity_need} free seat(s)`);
  }

  const roads = await tx.query('SELECT * FROM blocked_roads');
  if (blockedRoadsVersion(roads as never) !== meta.blocked_version) throw stale('road blockages changed after it was computed');

  const active = await tx.one(
    `SELECT id, incident_id FROM resource_assignments
     WHERE resource_id = $1 AND id <> $2 AND status IN ('dispatched', 'en_route', 'arrived') FOR UPDATE`,
    [resource.id, a.id],
  );
  if (active && !(meta.kind === 'move' && active.id === meta.replaces_assignment_id)) {
    throw new ApprovalConflict(`${resource.name} has been committed to another incident since this recommendation was made`, 409, 'allocation_conflict');
  }
  if (meta.kind === 'move' && !active) throw stale(`${resource.name} is no longer on the assignment this move was planned from`);
}

/** After a replacement proposal is approved: close the assignment it replaces (same transaction). */
export async function closeReplacedAssignment(tx: Queryable, a: Row, user: AuthUser, changes: ChangeSet): Promise<void> {
  const meta = a.allocation as AllocationMeta | null;
  if (meta?.kind !== 'replacement' || !meta.replaces_assignment_id) return;
  const old = await tx.one(
    `UPDATE resource_assignments SET status = 'rejected', coordinator_action = 'replaced', updated_at = now()
     WHERE id = $1 AND status IN ('dispatched', 'en_route') RETURNING *`,
    [meta.replaces_assignment_id],
  );
  if (!old) return; // already closed or on scene: nothing to replace
  changes.assignments.add(old.id);
  const freed = await tx.one(
    `UPDATE resources SET status = ${FREED_STATUS_SQL}, assigned_incident_id = NULL, eta_minutes = NULL, updated_at = now()
     WHERE id = $1 AND assigned_incident_id = $2 RETURNING id, name`,
    [old.resource_id, old.incident_id],
  );
  if (freed) changes.resources.add(freed.id);
  await audit(tx, {
    entityType: 'assignment', entityId: old.id, incidentId: old.incident_id, action: 'replaced', user,
    details: { resource_name: freed?.name ?? null, replaced_by_assignment: a.id, reason: 'replacement approved' },
  });
}

/**
 * MVP capacity model. Only ambulance transport changes load in the workflow:
 *   arrived               → the ambulance takes on the slot's patients (current_load += need)
 *   arrived → completed   → patients handed over: ambulance load −= need, destination hospital load += need
 * Fire trucks, police and road crews are single operational units (capacity not modelled).
 * Shelters are only checked for free space; nothing in the workflow records evacuee arrival.
 */
export async function applyTransportLoad(tx: Queryable, a: Row, from: string, to: string, changes: ChangeSet): Promise<void> {
  const meta = a.allocation as AllocationMeta | null;
  const need = meta?.slot?.capacity_need ?? 0;
  if (need <= 0) return;
  const r = await tx.one('SELECT id, type FROM resources WHERE id = $1', [a.resource_id]);
  if (r?.type !== 'ambulance') return;
  if (to === 'arrived') {
    await tx.query('UPDATE resources SET current_load = LEAST(capacity, current_load + $1), updated_at = now() WHERE id = $2', [need, r.id]);
    changes.resources.add(r.id);
  } else if (to === 'completed' && from === 'arrived') {
    await tx.query('UPDATE resources SET current_load = GREATEST(0, current_load - $1), updated_at = now() WHERE id = $2', [need, r.id]);
    changes.resources.add(r.id);
    if (meta?.destination?.id) {
      const h = await tx.one(
        `UPDATE resources SET current_load = LEAST(capacity, current_load + $1), updated_at = now()
         WHERE id = $2 AND type = 'hospital' RETURNING id`,
        [need, meta.destination.id],
      );
      if (h) changes.resources.add(h.id);
    }
  }
}

export function isApprovalConflict(err: unknown): err is ApprovalConflict {
  return err instanceof ApprovalConflict;
}
