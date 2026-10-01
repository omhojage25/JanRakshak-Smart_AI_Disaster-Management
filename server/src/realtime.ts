import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { readCookie, SESSION_COOKIE, userFromToken, type AuthUser } from './auth.js';
import { getDb } from './db.js';
import { buildPublicView } from './services/publicTracking.js';

export type Entity = 'incident' | 'resource' | 'assignment' | 'blocked_road' | 'notification';

/** Event sent on the public namespace, carrying only the public-safe incident view. */
export const PUBLIC_STATUS_EVENT = 'incident.status.updated';
const PUBLIC_NS = '/public';
const PUBLIC_DEBOUNCE_MS = 300;

let io: Server | null = null;
const publicTimers = new Map<string, NodeJS.Timeout>();
const lastPublic = new Map<string, string>();

const publicRoom = (incidentId: string) => `incident:${incidentId}`;

function initPublicNamespace(server: Server) {
  // No login: citizens follow a single incident by its id and only ever receive the public-safe view.
  server.of(PUBLIC_NS).on('connection', (socket) => {
    socket.on('track', (incidentId: unknown) => {
      if (typeof incidentId !== 'string' || incidentId.length > 64) return;
      for (const room of socket.rooms) if (room !== socket.id) void socket.leave(room);
      void socket.join(publicRoom(incidentId));
    });
  });
  server.of(PUBLIC_NS).adapter.on('delete-room', (room: string) => {
    if (room.startsWith('incident:')) lastPublic.delete(room);
  });
}

/** Coalesces bursts of staff changes into one public update per incident, sent only if someone is watching. */
function schedulePublicUpdate(incidentId: unknown) {
  if (!io || io.of(PUBLIC_NS).adapter.rooms.size === 0 || typeof incidentId !== 'string') return;
  clearTimeout(publicTimers.get(incidentId));
  publicTimers.set(incidentId, setTimeout(() => {
    publicTimers.delete(incidentId);
    // Citizens may be tracking this incident or one that was merged into it (they follow the canonical one).
    getDb().query('SELECT id FROM incidents WHERE parent_incident_id = $1', [incidentId])
      .then(async (children) => {
        const rooms = [incidentId, ...children.map((c) => c.id as string)].map(publicRoom)
          .filter((r) => io?.of(PUBLIC_NS).adapter.rooms.get(r)?.size);
        if (!rooms.length) return;
        const view = await buildPublicView(getDb(), incidentId);
        if (!io || !view) return;
        const payload = JSON.stringify(view);
        for (const room of rooms) {
          if (lastPublic.get(room) === payload) continue;
          lastPublic.set(room, payload);
          io.of(PUBLIC_NS).to(room).emit(PUBLIC_STATUS_EVENT, view);
        }
      })
      .catch((err) => console.error('[public tracking]', err));
  }, PUBLIC_DEBOUNCE_MS));
}

function incidentOf(entity: Entity, action: 'upsert' | 'delete', data: unknown): unknown {
  const row = data as Record<string, unknown> | null;
  if (!row) return null;
  if (entity === 'incident') return row.id;
  if (entity === 'assignment' && action === 'upsert') return row.incident_id;
  if (entity === 'resource') return row.assigned_incident_id;
  return null;
}

export function initRealtime(server: HttpServer) {
  io = new Server(server, { serveClient: false });

  io.use(async (socket, next) => {
    try {
      const user = await userFromToken(readCookie(socket.handshake.headers.cookie, SESSION_COOKIE));
      if (!user) {
        next(new Error('unauthorized'));
        return;
      }
      socket.data.user = user;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as AuthUser;
    socket.join(`user:${user.id}`);
  });

  initPublicNamespace(io);
}

export function broadcast(entity: Entity, action: 'upsert' | 'delete', data: unknown) {
  io?.emit('change', { entity, action, data });
  if (entity === 'incident' && action === 'delete') {
    const id = (data as { id?: string })?.id;
    if (id) io?.of(PUBLIC_NS).to(publicRoom(id)).emit(PUBLIC_STATUS_EVENT, { id, removed: true });
    return;
  }
  schedulePublicUpdate(incidentOf(entity, action, data));
}

export function disconnectUser(userId: string) {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

export async function closeRealtime() {
  if (!io) return;
  const current = io;
  io = null;
  for (const t of publicTimers.values()) clearTimeout(t);
  publicTimers.clear();
  await current.close();
}
