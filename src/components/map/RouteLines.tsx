import { useEffect, useMemo, useState } from 'react';
import { Polyline, Tooltip } from 'react-leaflet';
import { useStore } from '../../store/useStore';
import { fetchRoute } from '../../lib/data';
import type { RoadRoute } from '../../types';

interface Leg {
  key: string;
  label: string;
  incidentId: string;
  proposed: boolean;
  from: [number, number];
  to: [number, number];
}

/**
 * Road routes (same routing service and blocked-road handling as the optimizer) from each moving unit to its incident.
 * The selected incident's routes are emphasised, and its pending proposals are drawn as dashed "proposed" routes.
 * Positions are rounded so small GPS jitter does not refetch.
 */
export function RouteLines() {
  const assignments = useStore((s) => s.assignments);
  const resources = useStore((s) => s.resources);
  const incidents = useStore((s) => s.incidents);
  const selectedId = useStore((s) => s.selectedIncidentId);
  const [routes, setRoutes] = useState<Record<string, RoadRoute>>({});

  const legs = useMemo(() => {
    const out: Leg[] = [];
    for (const a of assignments) {
      const moving = a.status === 'dispatched' || a.status === 'en_route';
      const proposed = a.status === 'recommended' && a.incident_id === selectedId;
      if (!moving && !proposed) continue;
      const r = resources.find((x) => x.id === a.resource_id);
      const i = incidents.find((x) => x.id === a.incident_id);
      if (r?.location_lat == null || r.location_lng == null || i?.location_lat == null || i.location_lng == null) continue;
      const from: [number, number] = [Number(r.location_lat.toFixed(3)), Number(r.location_lng.toFixed(3))];
      const to: [number, number] = [i.location_lat, i.location_lng];
      out.push({ key: `${a.id}:${from.join(',')}`, label: r.name, incidentId: i.id, proposed, from, to });
    }
    return out;
  }, [assignments, resources, incidents, selectedId]);

  useEffect(() => {
    let cancelled = false;
    const wanted = new Set(legs.map((l) => l.key));
    for (const leg of legs) {
      // fetchRoute caches by coordinates, so re-running this for unchanged legs costs nothing.
      fetchRoute(leg.from, leg.to)
        .then((route) => {
          if (cancelled) return;
          setRoutes((prev) => {
            if (prev[leg.key] === route) return prev;
            const next: Record<string, RoadRoute> = {};
            for (const [k, v] of Object.entries(prev)) if (wanted.has(k)) next[k] = v;
            next[leg.key] = route;
            return next;
          });
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [legs]);

  // Draw de-emphasised routes first so the selected incident's routes sit on top.
  const ordered = [...legs].sort((a, b) => Number(a.incidentId === selectedId) - Number(b.incidentId === selectedId));

  return (
    <>
      {ordered.map((leg) => {
        const route = routes[leg.key];
        if (!route) return null;
        const focused = !selectedId || leg.incidentId === selectedId;
        const mins = Math.max(1, Math.round(route.duration_s / 60));
        return (
          <Polyline
            key={leg.key}
            positions={route.coordinates}
            pathOptions={leg.proposed
              ? { color: '#a5b4fc', weight: 3, opacity: 0.9, dashArray: '2 7', lineCap: 'round' }
              : { color: '#38bdf8', weight: focused && selectedId ? 5 : 3.5, opacity: focused ? 0.9 : 0.3, dashArray: route.source === 'straight_line' ? '6 8' : undefined }}
          >
            <Tooltip sticky>
              {leg.proposed ? 'Proposed: ' : ''}{leg.label} · {(route.distance_m / 1000).toFixed(1)} km · ~{mins} min by road
            </Tooltip>
          </Polyline>
        );
      })}
    </>
  );
}
