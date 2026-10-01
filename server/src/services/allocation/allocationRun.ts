/**
 * One optimizer run against the database: load a snapshot, plan globally, and persist the plan as
 * the EXISTING resource_assignments 'recommended' rows (no second assignment system). Nothing is
 * dispatched or cancelled here — the coordinator approves proposals through the existing workflow.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Queryable, Row } from '../../db.js';
import { ACTIVE_INCIDENT_STATUSES, sqlList } from '../../constants.js';
import { ChangeSet } from '../../rows.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { ALLOCATION_CONFIG as C } from './config.js';
import { planAllocation, type Plan, type Proposal } from './optimizer.js';
import type { AllocResource, Commitment } from './candidates.js';

export const ALLOCATION_META_VERSION = 1;

/** Shape of resource_assignments.allocation for optimizer-created rows. */
export interface AllocationMeta {
  version: number;
  run_id: string;
  trigger: string;
  key: string;
  kind: Proposal['kind'];
  slot: Proposal['slot'];
  incident_risk: { priority: string; priority_score: number };
  utility: Proposal['utility'];
  eta: { minutes: number; distance_m: number | null; source: string | null; route_via: string; gps_fresh: boolean };
  replaces_assignment_id: string | null;
  move_from_incident_id: string | null;
  backfill_for_assignment_id: string | null;
  destination: Proposal['destination'];
  destination_warning: string | null;
  alternatives: Proposal['alternatives'];
  blocked_version: string;
  plan_mode: Plan['mode'];
  degraded: boolean;
  created_at: string;
}

export async function loadSnapshot(q: Queryable) {
  const [incidents, resources, commitments, rejections, blockedRoads] = await Promise.all([
    q.query(`SELECT * FROM incidents WHERE status IN (${sqlList(ACTIVE_INCIDENT_STATUSES)})`),
    q.query('SELECT * FROM resources'),
    q.query(`SELECT id AS assignment_id, resource_id, incident_id, status, eta_minutes, updated_at
             FROM resource_assignments WHERE status IN ('dispatched', 'en_route', 'arrived')`),
    q.query(`SELECT resource_id, incident_id FROM resource_assignments
             WHERE status = 'rejected' AND coordinator_action = 'rejected'
               AND updated_at > now() - make_interval(mins => $1::int)`, [C.rejectionCooldownMin]),
    q.query('SELECT * FROM blocked_roads'),
  ]);
  return {
    incidents: incidents as never,
    resources: resources as unknown as AllocResource[],
    commitments: commitments as unknown as Commitment[],
    rejections: rejections as { resource_id: string; incident_id: string }[],
    blockedRoads: blockedRoads as never,
  };
}

const TYPE_LABEL = (t: string) => t.replace('_', ' ');

export function describeProposal(p: Proposal, runId: string): string {
  const u = p.utility;
  const caps = p.slot.required_caps.length ? ` (requires ${p.slot.required_caps.join(', ')})` : '';
  const parts = [
    `Global plan ${runId.slice(0, 8)}: ${TYPE_LABEL(p.slot.resource_type)} #${p.slot.index}${caps} for a ${p.incident_priority.toUpperCase()} incident (priority score ${p.incident_priority_score}) — ${p.slot.purpose}.`,
    `Road ETA ${u.eta_min} min (${p.route_via === 'table' ? 'road matrix' : `verified route, ${p.route_via}`}).`,
    `Utility ${u.net} = risk ${u.risk_weight} × importance ${u.slot_importance} × (time ${u.eta_value}, fit ${u.fit}) − scarcity ${u.scarcity}${u.reassignment_cost ? ` − reassignment ${u.reassignment_cost}` : ''}.`,
  ];
  if (p.kind === 'move') parts.push('MOVE: this unit is currently committed to another incident; approving reassigns it (a replacement for that incident is proposed separately when available).');
  if (p.kind === 'replacement') parts.push('REPLACEMENT: the current assignment for this slot is no longer feasible; approving closes it.');
  if (p.kind === 'backfill') parts.push('BACKFILL: covers this incident if the proposed move of its current unit is approved.');
  if (p.destination) parts.push(`Destination: ${p.destination.name} (${p.destination.free_beds} beds free after this plan).`);
  if (p.destination_warning) parts.push(`Warning: ${p.destination_warning}.`);
  return parts.join(' ');
}

function metaFor(plan: Plan, p: Proposal): AllocationMeta {
  return {
    version: ALLOCATION_META_VERSION, run_id: plan.run_id, trigger: plan.trigger, key: p.key, kind: p.kind, slot: p.slot,
    incident_risk: { priority: p.incident_priority, priority_score: p.incident_priority_score },
    utility: p.utility,
    eta: { minutes: p.eta_min, distance_m: p.distance_m, source: plan.routing_backend, route_via: p.route_via, gps_fresh: p.gps_fresh },
    replaces_assignment_id: p.replaces_assignment_id, move_from_incident_id: p.move_from_incident_id,
    backfill_for_assignment_id: p.backfill_for_assignment_id, destination: p.destination, destination_warning: p.destination_warning,
    alternatives: p.alternatives, blocked_version: plan.blocked_version, plan_mode: plan.mode, degraded: plan.degraded,
    created_at: new Date().toISOString(),
  };
}

export interface RunOptions {
  trigger: string;
  allowMoves?: boolean;
  /** /recommend for one incident: also clears that incident's legacy (non-optimizer) suggestions. */
  focusIncidentId?: string;
}

let lastDegraded = false;

/** Plans globally and persists proposals. Returns the plan and the ids of rows written per proposal key. */
export async function runOptimization(db: Queryable & { transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> }, opts: RunOptions) {
  const runId = uuidv4();
  const snapshot = await loadSnapshot(db);
  const plan = await planAllocation({
    runId, trigger: opts.trigger, allowMoves: opts.allowMoves ?? true, now: new Date(), ...snapshot,
  });

  const changes = new ChangeSet();
  const newlyProposed: Proposal[] = [];
  const rowIds = new Map<string, string>();
  await db.transaction(async (tx) => {
    if (!plan.degraded) {
      if (opts.focusIncidentId) {
        const legacy = await tx.query(
          `DELETE FROM resource_assignments WHERE incident_id = $1 AND status = 'recommended' AND allocation IS NULL RETURNING id`,
          [opts.focusIncidentId],
        );
        for (const l of legacy) changes.deletedAssignments.add(l.id);
      }
      const existing = await tx.query(`SELECT * FROM resource_assignments WHERE status = 'recommended' AND allocation IS NOT NULL`);
      const byKey = new Map<string, Row>(existing.map((e) => [(e.allocation as AllocationMeta).key, e]));
      const wanted = new Set(plan.proposals.map((p) => p.key));
      for (const e of existing) {
        if (!wanted.has((e.allocation as AllocationMeta).key)) {
          await tx.query('DELETE FROM resource_assignments WHERE id = $1', [e.id]);
          changes.deletedAssignments.add(e.id);
        }
      }
      for (const p of plan.proposals) {
        const meta = metaFor(plan, p);
        const reasoning = describeProposal(p, plan.run_id);
        const prev = byKey.get(p.key);
        if (prev) {
          await tx.query(
            `UPDATE resource_assignments SET allocation = $1, ai_score = $2, ai_reasoning = $3, eta_minutes = $4, updated_at = now() WHERE id = $5`,
            [JSON.stringify(meta), p.utility.net, reasoning, Math.round(p.eta_min), prev.id],
          );
          changes.assignments.add(prev.id);
          rowIds.set(p.key, prev.id);
          continue;
        }
        // Never duplicate a pair that already has a manual suggestion or an active assignment.
        const dup = await tx.one(
          `SELECT id FROM resource_assignments WHERE incident_id = $1 AND resource_id = $2 AND status IN ('recommended', 'dispatched', 'en_route', 'arrived')`,
          [p.incident_id, p.resource_id],
        );
        if (dup) continue;
        const id = uuidv4();
        await tx.query(
          `INSERT INTO resource_assignments (id, incident_id, resource_id, status, ai_score, ai_reasoning, eta_minutes, allocation)
           VALUES ($1, $2, $3, 'recommended', $4, $5, $6, $7)`,
          [id, p.incident_id, p.resource_id, p.utility.net, reasoning, Math.round(p.eta_min), JSON.stringify(meta)],
        );
        changes.assignments.add(id);
        rowIds.set(p.key, id);
        if (p.kind !== 'new') newlyProposed.push(p);
      }
    }
    await audit(tx, {
      entityType: 'allocation', entityId: plan.run_id, incidentId: opts.focusIncidentId ?? null, action: 'allocation_run',
      details: {
        trigger: plan.trigger, degraded: plan.degraded, degraded_reason: plan.degraded_reason, mode: plan.mode,
        objective: plan.objective, objective_no_moves: plan.objective_no_moves, objective_with_moves: plan.objective_with_moves,
        routing_backend: plan.routing_backend, blocked_version: plan.blocked_version, stats: plan.stats,
        infeasible_commitments: plan.infeasible_commitments, warnings: plan.warnings, shelters: plan.shelters,
        unmet_essential: plan.slots.filter((s) => s.status === 'unmet' && s.slot.essential)
          .map((s) => ({ slot: s.slot.id, reason: s.reason })).slice(0, 50),
      },
    });
  });
  await changes.publish(db);

  if (plan.degraded && !lastDegraded) {
    await notify({ type: 'warning', title: 'Allocation degraded: road routing unavailable', message: `${plan.degraded_reason}. Assign units manually until routing recovers.` });
  }
  lastDegraded = plan.degraded;
  for (const p of newlyProposed) {
    await notify({
      type: 'warning',
      title: p.kind === 'move' ? 'Reallocation proposed' : p.kind === 'replacement' ? 'Replacement unit proposed' : 'Backfill unit proposed',
      message: `${p.resource_name} → ${p.slot.resource_type.replace('_', ' ')} for ${p.incident_priority.toUpperCase()} incident. Coordinator approval required.`,
      incidentId: p.incident_id,
    });
  }
  return { plan, rowIds };
}
