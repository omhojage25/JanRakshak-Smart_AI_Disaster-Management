import type { Queryable, Row } from '../db.js';

/**
 * Public-safe view of an incident for the citizen tracking page (contract rule 4).
 * Only what a member of the public needs to see progress: no reporter details, raw messages,
 * unit names, AI scores or coordinator notes. Built from the existing incident/assignment
 * statuses; it adds no state of its own.
 */

export const TRACK_STEPS = [
  { key: 'received', label: 'Report received' },
  { key: 'assessed', label: 'Incident assessed' },
  { key: 'assigned', label: 'Response unit assigned' },
  { key: 'en_route', label: 'Unit en route' },
  { key: 'arrived', label: 'Arrived' },
  { key: 'contained', label: 'Incident contained' },
  { key: 'resolved', label: 'Resolved' },
] as const;

type StepKey = (typeof TRACK_STEPS)[number]['key'];

export interface PublicResponder {
  resource_type: string;
  status: 'dispatched' | 'en_route' | 'arrived';
  eta_minutes: number | null;
  /** Only while en route and the unit's own GPS is fresh and reasonably accurate. */
  live_location: { lat: number; lng: number; updated_at: string } | null;
}

export interface PublicIncidentView {
  id: string;
  type: string;
  priority: string;
  status: string;
  area: string | null;
  location: { lat: number; lng: number } | null;
  created_at: string;
  updated_at: string;
  current_step: StepKey;
  steps: { key: StepKey; label: string; state: 'done' | 'current' | 'pending'; at: string | null }[];
  responders: PublicResponder[];
  /** A previously assigned unit was redirected and nothing has replaced it yet. */
  response_changed: boolean;
}

const LIVE_WINDOW_MS = 2 * 60_000;
const MAX_ACCURACY_M = 300;
const ASSIGNMENT_LEVEL: Record<string, number> = { dispatched: 2, en_route: 3, arrived: 4 };
const INCIDENT_LEVEL: Record<string, number> = { triage: 1, dispatched: 1, on_scene: 4, contained: 5, resolved: 6, closed: 6 };

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

function liveLocation(resource: Row | undefined): PublicResponder['live_location'] {
  if (!resource || resource.location_lat == null || resource.location_lng == null || !resource.location_updated_at) return null;
  const at = new Date(resource.location_updated_at).getTime();
  if (Number.isNaN(at) || Date.now() - at > LIVE_WINDOW_MS) return null;
  if (resource.location_accuracy_m != null && resource.location_accuracy_m > MAX_ACCURACY_M) return null;
  return { lat: resource.location_lat, lng: resource.location_lng, updated_at: iso(resource.location_updated_at)! };
}

/** First time each milestone was reached, read from the existing audit log. */
function milestoneTimes(audit: Row[], incident: Row): Partial<Record<StepKey, string>> {
  const at: Partial<Record<StepKey, string>> = {
    received: iso(incident.created_at)!,
    assessed: iso(incident.created_at)!,
  };
  const mark = (key: StepKey, when: unknown) => {
    if (!at[key]) at[key] = iso(when)!;
  };
  for (const e of audit) {
    const to = e.details?.to;
    if (e.entity_type === 'assignment') {
      if (e.action === 'approved' || e.action === 'dispatched') mark('assigned', e.created_at);
      if (e.action === 'en_route') mark('en_route', e.created_at);
      if (e.action === 'arrived') mark('arrived', e.created_at);
    } else if (e.entity_type === 'incident' && e.action === 'status_changed') {
      if (to === 'dispatched') mark('assigned', e.created_at);
      if (to === 'on_scene') mark('arrived', e.created_at);
      if (to === 'contained') mark('contained', e.created_at);
      if (to === 'resolved') mark('resolved', e.created_at);
    }
  }
  return at;
}

export async function buildPublicView(q: Queryable, incidentId: string): Promise<PublicIncidentView | null> {
  let incident = await q.one('SELECT * FROM incidents WHERE id = $1', [incidentId]);
  // A report merged into another incident is tracked through the incident it was merged into.
  if (incident?.parent_incident_id) {
    incident = (await q.one('SELECT * FROM incidents WHERE id = $1', [incident.parent_incident_id])) ?? incident;
  }
  if (!incident) return null;

  const [assignments, audit] = await Promise.all([
    q.query(
      `SELECT ra.status, ra.eta_minutes, ra.coordinator_action, r.type AS resource_type,
              r.location_lat, r.location_lng, r.location_accuracy_m, r.location_updated_at
       FROM resource_assignments ra JOIN resources r ON ra.resource_id = r.id
       WHERE ra.incident_id = $1 AND ra.status IN ('dispatched', 'en_route', 'arrived', 'completed', 'rejected')
       ORDER BY ra.created_at ASC`,
      [incident.id],
    ),
    q.query(
      `SELECT entity_type, action, details, created_at FROM audit_log
       WHERE incident_id = $1 ORDER BY created_at ASC LIMIT 500`,
      [incident.id],
    ),
  ]);

  const active = assignments.filter((a) => a.status in ASSIGNMENT_LEVEL);
  const finished = assignments.some((a) => a.status === 'completed');
  let level = INCIDENT_LEVEL[incident.status] ?? 1;
  for (const a of active) level = Math.max(level, ASSIGNMENT_LEVEL[a.status]);
  if (finished) level = Math.max(level, 4);
  // Incident says "dispatched" but no unit is currently committed (e.g. it was redirected): show it honestly.
  if (incident.status === 'dispatched' && active.length === 0 && !finished) level = 1;

  const redirected = assignments.some((a) => a.status === 'rejected' && a.coordinator_action === 'reassigned');
  const times = milestoneTimes(audit, incident);
  const steps = TRACK_STEPS.map((s, i) => {
    const state: 'done' | 'current' | 'pending' = i < level ? 'done' : i === level ? 'current' : 'pending';
    return { key: s.key, label: s.label, state, at: state === 'pending' ? null : times[s.key] ?? null };
  });
  // Once resolved there is no "next" step: the last step itself is complete.
  if (level >= 6) steps[6].state = 'done';

  return {
    id: incident.id,
    type: incident.type,
    priority: incident.priority,
    status: incident.status,
    area: incident.location_name ?? null,
    location: incident.location_lat != null && incident.location_lng != null
      ? { lat: incident.location_lat, lng: incident.location_lng }
      : null,
    created_at: iso(incident.created_at)!,
    updated_at: iso(incident.updated_at)!,
    current_step: TRACK_STEPS[Math.min(level, 6)].key,
    steps,
    responders: level >= 6 ? [] : active.map((a) => ({
      resource_type: a.resource_type,
      status: a.status,
      eta_minutes: a.status === 'arrived' ? null : a.eta_minutes ?? null,
      live_location: a.status === 'en_route' ? liveLocation(a) : null,
    })),
    response_changed: redirected && active.length === 0 && level < 4,
  };
}
