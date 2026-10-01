import { api } from './http';
import { useStore } from '../store/useStore';
import type {
  AppNotification, AuditEntry, BlockedRoad, ExhaustionPrediction, ExtractionResult, ImpactAssessment, Incident,
  IncidentDetailData, IncidentStatus, ManagedUser, Resource, ResourceAssignment, RoadRoute, Report, Role,
  AssignmentStatus, PublicIncidentView, IncidentDemand, RecommendResult,
} from '../types';

const store = () => useStore.getState();

export async function fetchAll() {
  store().setLoading(true);
  try {
    const [incidents, resources, assignments, blockedRoads] = await Promise.all([
      api<Incident[]>('/incidents'),
      api<Resource[]>('/resources'),
      api<ResourceAssignment[]>('/assignments'),
      api<BlockedRoad[]>('/blocked-roads'),
    ]);
    store().setData({ incidents, resources, assignments, blockedRoads });
    store().setError(null);
  } catch (err) {
    store().setError((err as Error).message);
    throw err;
  } finally {
    store().setLoading(false);
  }
}

export async function fetchAuditLog() {
  store().setAuditLog(await api<AuditEntry[]>('/audit?limit=100'));
}

export async function fetchPredictions() {
  store().setPredictions(await api<ExhaustionPrediction[]>('/predictions'));
}

export async function fetchNotifications() {
  store().setNotifications(await api<AppNotification[]>('/notifications'));
}

export async function markNotificationRead(id: string) {
  store().markNotificationsRead([id]);
  await api(`/notifications/${id}/read`, { method: 'POST' });
}

export async function markAllNotificationsRead() {
  store().markNotificationsRead('all');
  await api('/notifications/read-all', { method: 'POST' });
}

export interface ReportPayload {
  raw_message: string;
  source: string;
  reporter_name?: string;
  reporter_phone?: string;
  reporter_lat?: number;
  reporter_lng?: number;
  /** GPS accuracy radius in metres, when the device reports it. */
  reporter_accuracy?: number;
  client_id: string;
  reported_at: string;
}

export interface ReportResult {
  status: 'accepted';
  report: Report;
  incident?: Incident;
  classification?: ExtractionResult | null;
  is_duplicate?: boolean;
  already_processed?: boolean;
  impact?: ImpactAssessment[];
}

export function postReport(payload: ReportPayload) {
  return api<ReportResult>('/reports', { method: 'POST', body: payload });
}

/** No login needed. The server answers 422 with code "location_required" when no location can be found. */
export function postPublicReport(payload: ReportPayload) {
  return api<ReportResult>('/public/reports', { method: 'POST', body: payload });
}

/** No login needed: the public-safe status view a citizen sees on /track/:id. */
export function fetchPublicTracking(id: string, signal?: AbortSignal) {
  return api<PublicIncidentView>(`/public/reports/track/${encodeURIComponent(id)}`, { signal });
}

export function fetchIncidentDetail(id: string, signal?: AbortSignal) {
  return api<IncidentDetailData>(`/incidents/${id}`, { signal });
}

export function fetchTimeline(id: string, signal?: AbortSignal) {
  return api<AuditEntry[]>(`/incidents/${id}/timeline`, { signal });
}

export async function transitionIncident(
  id: string,
  to: IncidentStatus,
  extra: { note?: string; review?: { summary: string; went_well?: string; improvements?: string } } = {},
) {
  const incident = await api<Incident>(`/incidents/${id}/transition`, { method: 'POST', body: { to, ...extra } });
  store().upsertIncident(incident);
  return incident;
}

/** Runs the global optimizer and returns this incident's slice. 503 "routing_unavailable" when routing is degraded. */
export async function recommendResources(incidentId: string) {
  return api<RecommendResult>(`/incidents/${incidentId}/recommend`, { method: 'POST' });
}

/** Read-only: the incident's unit requirements from the optimizer's demand model. */
export function fetchIncidentDemand(incidentId: string, signal?: AbortSignal) {
  return api<IncidentDemand>(`/incidents/${incidentId}/demand`, { signal });
}

export type LocationAction =
  | { action: 'verify'; note?: string }
  | { action: 'correct'; lat: number; lng: number; location_name?: string; note?: string }
  | { action: 'choose_candidate'; candidate_index: number; location_name?: string; note?: string };

export async function updateIncidentLocation(incidentId: string, body: LocationAction) {
  const incident = await api<Incident & { dedup_check: string }>(`/incidents/${incidentId}/location`, { method: 'PATCH', body });
  store().upsertIncident(incident);
  return incident;
}

export async function reviewDuplicate(incidentId: string, body: { decision: 'separate' } | { decision: 'merge'; target_incident_id: string }) {
  const res = await api<{ source: Incident; target: Incident | null }>(`/incidents/${incidentId}/duplicate-review`, { method: 'POST', body });
  store().upsertIncident(res.source);
  if (res.target) store().upsertIncident(res.target);
  return res;
}

/** Manual coordinator proposal: creates a "recommended" row that still needs approval like any other. */
export async function proposeAssignment(incidentId: string, resourceId: string, notes?: string) {
  const row = await api<ResourceAssignment>('/assignments', {
    method: 'POST',
    body: { incident_id: incidentId, resource_id: resourceId, coordinator_notes: notes },
  });
  store().upsertAssignment(row);
  return row;
}

export async function addBlockedRoad(body: {
  start_lat: number; start_lng: number; end_lat: number; end_lng: number;
  road_name?: string; reason?: string; incident_id?: string;
}) {
  const road = await api<BlockedRoad>('/blocked-roads', { method: 'POST', body });
  store().upsertBlockedRoad(road);
  return road;
}

export async function removeBlockedRoad(id: string) {
  await api(`/blocked-roads/${id}`, { method: 'DELETE' });
  store().removeBlockedRoad(id);
}

export async function updateAssignment(id: string, status: AssignmentStatus, opts: { force?: boolean; notes?: string } = {}) {
  const row = await api<ResourceAssignment>(`/assignments/${id}`, {
    method: 'PATCH',
    body: { status, force: opts.force, coordinator_notes: opts.notes },
  });
  store().upsertAssignment(row);
  return row;
}

export async function shareLocation(resourceId: string, lat: number, lng: number, accuracy?: number) {
  return api<Resource>(`/resources/${resourceId}/location`, { method: 'POST', body: { lat, lng, accuracy } });
}

export function fetchResourceDetail(id: string) {
  return api<Resource & { assignments: (ResourceAssignment & { incident_lat: number | null; incident_lng: number | null; incident_location: string | null })[] }>(`/resources/${id}`);
}

const routeCache = new Map<string, Promise<RoadRoute>>();

export function fetchRoute(from: [number, number], to: [number, number]) {
  const key = [...from, ...to].map((n) => n.toFixed(4)).join(',');
  let pending = routeCache.get(key);
  if (!pending) {
    pending = api<RoadRoute>(`/routes?from=${from[0]},${from[1]}&to=${to[0]},${to[1]}`);
    // Failures (e.g. 409 when every route is blocked) are remembered briefly so the map doesn't re-request on every update.
    pending.catch(() => window.setTimeout(() => routeCache.delete(key), 60_000));
    routeCache.set(key, pending);
    if (routeCache.size > 200) routeCache.delete(routeCache.keys().next().value!);
  }
  return pending;
}

export const usersApi = {
  list: () => api<ManagedUser[]>('/users'),
  create: (body: { username: string; full_name: string; password: string; role: Role; resource_id?: string | null }) =>
    api<ManagedUser>('/users', { method: 'POST', body }),
  update: (id: string, body: Partial<{ full_name: string; role: Role; active: boolean; password: string; resource_id: string | null }>) =>
    api<ManagedUser>(`/users/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => api(`/users/${id}`, { method: 'DELETE' }),
};
