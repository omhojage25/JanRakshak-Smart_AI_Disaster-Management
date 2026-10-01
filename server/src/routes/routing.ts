import { Router } from 'express';
import { getDb } from '../db.js';
import { route } from '../http.js';
import { latLng, ValidationError } from '../validate.js';
import { RoutingUnavailableError, getRoutingProvider, verifiedRoute } from '../services/routing.js';

const router = Router();

function parsePoint(value: unknown, label: string) {
  if (typeof value !== 'string') throw new ValidationError(`${label} is required as "lat,lng"`);
  const [lat, lng] = value.split(',');
  const point = latLng(lat, lng, label);
  if (!point) throw new ValidationError(`${label} is required as "lat,lng"`);
  return point;
}

// Road route for the map and the field-unit screen. Same routing service (and blocked-road
// handling) as the allocation optimizer, so both show the same ETA. No straight-line fallback.
router.get('/', route('Failed to compute route', async (req, res) => {
  const from = parsePoint(req.query.from, 'from');
  const to = parsePoint(req.query.to, 'to');
  try {
    const roads = await getDb().query('SELECT * FROM blocked_roads');
    const v = await verifiedRoute(from, to, roads as never);
    if (v.status === 'no_route') {
      res.status(404).json({ error: 'No road route found', code: 'no_route' });
      return;
    }
    if (v.status === 'blocked') {
      res.status(409).json({ error: 'Every route found passes a blocked road', code: 'route_blocked', blocked_by: v.blocked_by });
      return;
    }
    res.json({
      coordinates: v.route.coordinates,
      distance_m: v.route.distance_m,
      duration_s: v.route.duration_s,
      source: 'osrm' as const,
      via: v.via,
      avoided_blocked_roads: v.avoided,
      backend: getRoutingProvider()?.id ?? null,
    });
  } catch (err) {
    if (!(err instanceof RoutingUnavailableError)) throw err;
    res.status(503).json({ error: `Road routing unavailable: ${err.message}`, code: 'routing_unavailable' });
  }
}));

export default router;
