import { create } from 'zustand';
import type {
  AppNotification, AuditEntry, BlockedRoad, ExhaustionPrediction, Incident, IncidentStatus, Resource,
  ResourceAssignment,
} from '../types';

export type FeedView = 'active' | 'resolved' | 'closed';
export type ConnectionState = 'connected' | 'connecting' | 'offline';

export interface MapLayers {
  zones: boolean;
  resources: boolean;
  routes: boolean;
  roads: boolean;
}

/** A map click the UI is waiting for (e.g. correcting an incident's location). */
export type MapPick = { purpose: 'incident_location'; incidentId: string } | null;

export interface Toast {
  id: string;
  type: AppNotification['type'];
  title: string;
  message: string;
  incident_id?: string | null;
}

interface AppState {
  incidents: Incident[];
  resources: Resource[];
  assignments: ResourceAssignment[];
  auditLog: AuditEntry[];
  blockedRoads: BlockedRoad[];
  predictions: ExhaustionPrediction[];
  notifications: AppNotification[];
  toasts: Toast[];
  selectedIncidentId: string | null;
  mapCenterLat: number;
  mapCenterLng: number;
  mapZoom: number;
  mapLayers: MapLayers;
  priorityFilter: string | null;
  feedView: FeedView;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  connection: ConnectionState;
  pendingReports: number;
  dataVersion: number;
  mapPick: MapPick;
  pickedPoint: { lat: number; lng: number; for: string } | null;

  setData: (data: Partial<Pick<AppState, 'incidents' | 'resources' | 'assignments' | 'blockedRoads'>>) => void;
  setAuditLog: (log: AuditEntry[]) => void;
  setPredictions: (p: ExhaustionPrediction[]) => void;
  upsertIncident: (i: Incident) => void;
  removeIncident: (id: string) => void;
  upsertResource: (r: Resource) => void;
  upsertBlockedRoad: (r: BlockedRoad) => void;
  removeBlockedRoad: (id: string) => void;
  startMapPick: (pick: MapPick) => void;
  completeMapPick: (lat: number, lng: number) => void;
  clearPickedPoint: () => void;
  upsertAssignment: (a: ResourceAssignment) => void;
  removeAssignment: (id: string) => void;
  setNotifications: (n: AppNotification[]) => void;
  addNotification: (n: AppNotification) => void;
  markNotificationsRead: (ids: string[] | 'all') => void;
  pushToast: (t: Toast) => void;
  dismissToast: (id: string) => void;
  selectIncident: (id: string | null) => void;
  selectAndFlyTo: (id: string | null, lat?: number | null, lng?: number | null) => void;
  setPriorityFilter: (p: string | null) => void;
  setFeedView: (v: FeedView) => void;
  toggleLayer: (layer: keyof MapLayers) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setConnection: (c: ConnectionState) => void;
  setPendingReports: (n: number) => void;
  reset: () => void;
}

const MAP_LAYERS_KEY = 'jr_map_layers';

function loadLayers(): MapLayers {
  const defaults: MapLayers = { zones: true, resources: true, routes: true, roads: true };
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_LAYERS_KEY) ?? '{}') as Record<string, unknown>;
    // Only known layers are kept, so settings saved by older versions (e.g. the removed heatmap) are ignored.
    const layers = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof MapLayers)[]) {
      if (typeof saved[key] === 'boolean') layers[key] = saved[key] as boolean;
    }
    return layers;
  } catch {
    return defaults;
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [item, ...list];
  const next = list.slice();
  next[idx] = item;
  return next;
}

const initialData = {
  incidents: [] as Incident[],
  resources: [] as Resource[],
  assignments: [] as ResourceAssignment[],
  auditLog: [] as AuditEntry[],
  blockedRoads: [] as BlockedRoad[],
  predictions: [] as ExhaustionPrediction[],
  notifications: [] as AppNotification[],
  toasts: [] as Toast[],
  selectedIncidentId: null as string | null,
  loaded: false,
  error: null as string | null,
  dataVersion: 0,
};

export const useStore = create<AppState>((set) => ({
  ...initialData,
  mapCenterLat: 19.076,
  mapCenterLng: 72.8777,
  mapZoom: 12,
  mapLayers: loadLayers(),
  priorityFilter: null,
  feedView: 'active',
  loading: false,
  connection: 'connecting',
  pendingReports: 0,
  mapPick: null,
  pickedPoint: null,

  setData: (data) => set((s) => ({ ...data, loaded: true, dataVersion: s.dataVersion + 1 })),
  setAuditLog: (auditLog) => set({ auditLog }),
  setPredictions: (predictions) => set({ predictions }),
  upsertIncident: (incident) => set((s) => ({
    incidents: incident.parent_incident_id
      ? s.incidents.filter((i) => i.id !== incident.id)
      : upsert(s.incidents, incident),
    dataVersion: s.dataVersion + 1,
  })),
  removeIncident: (id) => set((s) => ({
    incidents: s.incidents.filter((i) => i.id !== id),
    assignments: s.assignments.filter((a) => a.incident_id !== id),
    selectedIncidentId: s.selectedIncidentId === id ? null : s.selectedIncidentId,
    dataVersion: s.dataVersion + 1,
  })),
  upsertResource: (resource) => set((s) => ({ resources: upsert(s.resources, resource), dataVersion: s.dataVersion + 1 })),
  upsertBlockedRoad: (road) => set((s) => ({ blockedRoads: upsert(s.blockedRoads, road) })),
  removeBlockedRoad: (id) => set((s) => ({ blockedRoads: s.blockedRoads.filter((r) => r.id !== id) })),
  startMapPick: (mapPick) => set({ mapPick, pickedPoint: null }),
  completeMapPick: (lat, lng) => set((s) => (s.mapPick
    ? { mapPick: null, pickedPoint: { lat, lng, for: s.mapPick.incidentId } }
    : {})),
  clearPickedPoint: () => set({ pickedPoint: null }),
  upsertAssignment: (assignment) => set((s) => ({ assignments: upsert(s.assignments, assignment), dataVersion: s.dataVersion + 1 })),
  removeAssignment: (id) => set((s) => ({ assignments: s.assignments.filter((a) => a.id !== id), dataVersion: s.dataVersion + 1 })),
  setNotifications: (notifications) => set({ notifications }),
  addNotification: (n) => set((s) => ({ notifications: upsert(s.notifications, n).slice(0, 50) })),
  markNotificationsRead: (ids) => set((s) => ({
    notifications: s.notifications.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n)),
  })),
  pushToast: (t) => set((s) => ({ toasts: [...s.toasts.filter((x) => x.id !== t.id), t].slice(-4) })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  selectIncident: (id) => set({ selectedIncidentId: id }),
  selectAndFlyTo: (id, lat, lng) => set(lat != null && lng != null
    ? { selectedIncidentId: id, mapCenterLat: lat, mapCenterLng: lng, mapZoom: 14 }
    : { selectedIncidentId: id }),
  setPriorityFilter: (priorityFilter) => set({ priorityFilter }),
  setFeedView: (feedView) => set({ feedView }),
  toggleLayer: (layer) => set((s) => {
    const mapLayers = { ...s.mapLayers, [layer]: !s.mapLayers[layer] };
    try {
      localStorage.setItem(MAP_LAYERS_KEY, JSON.stringify(mapLayers));
    } catch {
      // storage unavailable; the toggle still applies for this session
    }
    return { mapLayers };
  }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setConnection: (connection) => set({ connection }),
  setPendingReports: (pendingReports) => set({ pendingReports }),
  reset: () => set({ ...initialData }),
}));

export function isActiveStatus(status: IncidentStatus) {
  return status === 'triage' || status === 'dispatched' || status === 'on_scene' || status === 'contained';
}
