import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { ApiError } from './http';
import { fetchPublicTracking } from './data';
import type { PublicIncidentView } from '../types';

/** Event name on the server's /public namespace (server/src/realtime.ts). */
const PUBLIC_STATUS_EVENT = 'incident.status.updated';

export type TrackingState =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; view: PublicIncidentView };

/**
 * Loads the public-safe view once, then keeps it current over the no-login /public socket.
 * On every (re)connect it refetches so nothing missed while offline is lost; no polling otherwise.
 */
export function useIncidentTracking(incidentId: string) {
  const [state, setState] = useState<TrackingState>({ kind: 'loading' });
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });

    const load = () => {
      fetchPublicTracking(incidentId)
        .then((view) => {
          if (cancelled) return;
          // A merged report is served under the incident it was merged into; follow that one live.
          if (view.id !== incidentId) socket.emit('track', view.id);
          setState({ kind: 'ready', view });
        })
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 404) setState({ kind: 'not_found' });
          else setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', message: (err as Error).message }));
        });
    };

    const socket = io('/public', { path: '/socket.io', reconnectionDelayMax: 10_000 });
    socket.on('connect', () => {
      setLive(true);
      socket.emit('track', incidentId);
      load();
    });
    socket.on('disconnect', () => setLive(false));
    socket.on('connect_error', () => {
      setLive(false);
      // Still show something if the socket can't connect at all.
      setState((prev) => { if (prev.kind === 'loading') load(); return prev; });
    });
    socket.on(PUBLIC_STATUS_EVENT, (payload: PublicIncidentView | { id: string; removed: true }) => {
      if (cancelled) return;
      if ('removed' in payload) setState({ kind: 'not_found' });
      else setState({ kind: 'ready', view: payload });
    });

    return () => {
      cancelled = true;
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [incidentId]);

  return { state, live };
}
