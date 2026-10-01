import { getDb } from '../db.js';
import { broadcast } from '../realtime.js';
import { ESCALATION_THRESHOLD_MIN, sqlList, ACTIVE_INCIDENT_STATUSES, type IncidentType } from '../constants.js';
import { checkEscalations } from './escalation.js';
import { predictExhaustion, type ExhaustionPrediction } from './prediction.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { reoptimize } from './allocation/reoptimize.js';
import { ALLOCATION_CONFIG } from './allocation/config.js';
import { RoutingUnavailableError, verifiedRoute } from './routing.js';

const TICK_MS = 30_000;
const RISK_RANK: Record<ExhaustionPrediction['risk_level'], number> = { low: 0, moderate: 1, high: 2, critical: 3 };
const lastRisk = new Map<string, ExhaustionPrediction['risk_level']>();

async function applyEscalations() {
  let escalated = 0;
  const db = getDb();
  const candidates = await db.query(
    `SELECT * FROM incidents WHERE status IN ('triage', 'dispatched') AND parent_incident_id IS NULL`,
  );
  for (const e of checkEscalations(candidates as never)) {
    const incident = candidates.find((c) => c.id === e.incident_id)!;
    const threshold = ESCALATION_THRESHOLD_MIN[incident.type as IncidentType] ?? 45;
    const updated = await db.transaction(async (tx) => {
      const row = await tx.one(
        `UPDATE incidents
         SET priority = $1, priority_score = $2, updated_at = now(),
             escalation_deadline = now() + make_interval(mins => $3::int)
         WHERE id = $4 AND status IN ('triage', 'dispatched')
         RETURNING *`,
        [e.new_priority, e.new_score, threshold, e.incident_id],
      );
      if (!row) return null;
      await audit(tx, {
        entityType: 'incident',
        entityId: row.id,
        incidentId: row.id,
        action: 'escalated',
        details: { from: e.old_priority, to: e.new_priority, score: e.new_score, reason: e.reason },
      });
      return row;
    });
    if (!updated) continue;
    escalated++;
    broadcast('incident', 'upsert', updated);
    await notify({
      type: e.new_priority === 'critical' ? 'critical' : 'warning',
      title: `Escalated: ${updated.title ?? 'Incident'}`,
      message: `${e.reason}. Priority ${e.old_priority} → ${e.new_priority}.`,
      incidentId: updated.id,
    });
  }
  // Priority is the optimizer's risk input, so an escalation can change the best allocation.
  if (escalated) reoptimize('incident_escalated');
}

/** Once per stale-GPS episode / drift episode per assignment, so a stuck unit does not spam re-runs. */
const flagged = new Map<string, number>();
const FLAG_TTL_MS = 10 * 60_000;

/**
 * Feasibility watch for units on the way: live GPS that stopped reporting, road ETA drifting well
 * past the plan, or the route becoming blocked. Any of these asks the optimizer for a replacement.
 */
async function checkActiveAssignments() {
  const db = getDb();
  const rows = await db.query(
    `SELECT ra.id, ra.status, ra.eta_minutes, ra.updated_at, r.id AS resource_id, r.location_lat, r.location_lng,
            r.location_updated_at, i.location_lat AS inc_lat, i.location_lng AS inc_lng
     FROM resource_assignments ra
     JOIN resources r ON r.id = ra.resource_id
     JOIN incidents i ON i.id = ra.incident_id
     WHERE ra.status IN ('dispatched', 'en_route')`,
  );
  if (!rows.length) return;
  const roads = await db.query('SELECT * FROM blocked_roads');
  const now = Date.now();
  for (const [k, at] of flagged) if (now - at > FLAG_TTL_MS) flagged.delete(k);
  for (const a of rows) {
    const gpsAt = a.location_updated_at ? new Date(a.location_updated_at).getTime() : null;
    const since = new Date(a.updated_at).getTime();
    // Tracking had started for this assignment and then stopped.
    if (a.status === 'en_route' && gpsAt && gpsAt > since && now - gpsAt > ALLOCATION_CONFIG.gpsStaleMin * 60_000) {
      if (!flagged.has(`gps:${a.id}`)) { flagged.set(`gps:${a.id}`, now); reoptimize('gps_stale', a.id); }
      continue;
    }
    if (!gpsAt || now - gpsAt > ALLOCATION_CONFIG.gpsFreshMin * 60_000 || a.inc_lat == null || a.location_lat == null) continue;
    try {
      const v = await verifiedRoute({ lat: a.location_lat, lng: a.location_lng }, { lat: a.inc_lat, lng: a.inc_lng }, roads as never);
      if (v.status !== 'ok') {
        if (!flagged.has(`route:${a.id}`)) { flagged.set(`route:${a.id}`, now); reoptimize('assignment_infeasible', a.id); }
        continue;
      }
      if (a.eta_minutes != null) {
        const expectedRemaining = Math.max(0, a.eta_minutes - (now - since) / 60_000);
        if (v.route.duration_s / 60 - expectedRemaining > ALLOCATION_CONFIG.etaDriftMin && !flagged.has(`drift:${a.id}`)) {
          flagged.set(`drift:${a.id}`, now);
          reoptimize('eta_drift', a.id);
        }
      }
    } catch (err) {
      if (!(err instanceof RoutingUnavailableError)) throw err;
      return; // routing down: the next optimizer run reports DEGRADED
    }
  }
}

async function checkResourceRisk() {
  const db = getDb();
  const resources = await db.query('SELECT * FROM resources');
  const incidents = await db.query(`SELECT * FROM incidents WHERE status IN (${sqlList(ACTIVE_INCIDENT_STATUSES)})`);
  for (const p of predictExhaustion(resources as never, incidents as never)) {
    const previous = lastRisk.get(p.resource_type);
    lastRisk.set(p.resource_type, p.risk_level);
    const worsened = previous !== undefined && RISK_RANK[p.risk_level] > RISK_RANK[previous];
    if (!worsened || RISK_RANK[p.risk_level] < RISK_RANK.high) continue;
    await notify({
      type: p.risk_level === 'critical' ? 'critical' : 'warning',
      title: `${p.resource_type.replace('_', ' ')} capacity ${p.risk_level === 'critical' ? 'exhausted' : 'running low'}`,
      message: p.recommendation,
    });
  }
}

export function startScheduler(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await applyEscalations();
      await checkResourceRisk();
      await checkActiveAssignments();
    } catch (err) {
      console.error('[scheduler]', err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 3_000);
  const interval = setInterval(tick, TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
