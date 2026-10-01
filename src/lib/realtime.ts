import { io, type Socket } from 'socket.io-client';
import { useStore } from '../store/useStore';
import { useAuth } from '../store/useAuth';
import { fetchAll, fetchAuditLog, fetchNotifications, fetchPredictions } from './data';
import { flushQueue } from './offlineQueue';
import { showDesktopNotification } from './desktopNotify';
import type { AppNotification, Incident, Resource, ResourceAssignment } from '../types';

type Change =
  | { entity: 'incident'; action: 'upsert'; data: Incident }
  | { entity: 'incident'; action: 'delete'; data: { id: string } }
  | { entity: 'resource'; action: 'upsert'; data: Resource }
  | { entity: 'assignment'; action: 'upsert'; data: ResourceAssignment }
  | { entity: 'assignment'; action: 'delete'; data: { id: string } }
  | { entity: 'notification'; action: 'upsert'; data: AppNotification }
  | { entity: 'blocked_road'; action: 'upsert' | 'delete'; data: unknown };

let socket: Socket | null = null;
let derivedTimer: number | undefined;
let auditWanted = false;

/** Audit and prediction data are recomputed on the server, so refetch them (debounced) after changes. */
function scheduleDerivedRefresh() {
  window.clearTimeout(derivedTimer);
  derivedTimer = window.setTimeout(() => {
    const staff = useAuth.getState().user?.role !== 'field_reporter';
    if (!staff) return;
    fetchPredictions().catch(() => {});
    if (auditWanted) fetchAuditLog().catch(() => {});
  }, 800);
}

export function setAuditFeedVisible(visible: boolean) {
  auditWanted = visible;
}

function applyChange(change: Change) {
  const s = useStore.getState();
  switch (change.entity) {
    case 'incident':
      if (change.action === 'delete') s.removeIncident(change.data.id);
      else s.upsertIncident(change.data);
      break;
    case 'resource':
      s.upsertResource(change.data);
      break;
    case 'assignment':
      if (change.action === 'delete') s.removeAssignment(change.data.id);
      else s.upsertAssignment(change.data);
      break;
    case 'notification': {
      const n = change.data;
      s.addNotification(n);
      s.pushToast({ id: n.id, type: n.type, title: n.title, message: n.message, incident_id: n.incident_id });
      showDesktopNotification(n, () => {
        if (!n.incident_id) return;
        const incident = useStore.getState().incidents.find((i) => i.id === n.incident_id);
        useStore.getState().selectAndFlyTo(n.incident_id, incident?.location_lat, incident?.location_lng);
      });
      return;
    }
    default:
      fetchAll().catch(() => {});
  }
  scheduleDerivedRefresh();
}

export function connectRealtime() {
  if (socket) return;
  const store = useStore.getState();
  store.setConnection('connecting');

  socket = io({ path: '/socket.io', withCredentials: true, reconnectionDelayMax: 10_000 });

  socket.on('connect', () => {
    useStore.getState().setConnection('connected');
    // Catch up on anything missed while disconnected.
    fetchAll().catch(() => {});
    fetchNotifications().catch(() => {});
    scheduleDerivedRefresh();
    void flushQueue();
  });

  socket.on('disconnect', (reason) => {
    useStore.getState().setConnection(navigator.onLine ? 'connecting' : 'offline');
    if (reason === 'io server disconnect') {
      // The server ends sockets when a session is revoked or re-issued (e.g. password change).
      void useAuth.getState().checkSession().then(() => {
        if (useAuth.getState().status === 'authenticated') socket?.connect();
      });
    }
  });

  socket.on('connect_error', (err) => {
    useStore.getState().setConnection(navigator.onLine ? 'connecting' : 'offline');
    if (err.message === 'unauthorized') {
      // Session expired or revoked: confirm with the API, which signs the user out if so.
      useAuth.getState().checkSession();
    }
  });

  socket.on('change', applyChange);
}

export function disconnectRealtime() {
  window.clearTimeout(derivedTimer);
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}
