/**
 * Deterministic routing backend for tests (no network).
 *  - travel time = Manhattan distance at a fixed speed
 *  - fastest route = L-shape "east/west first, then north/south"; alternative = the mirrored L
 *  - via routes are straight legs through the waypoint (can be disabled to simulate "no detour")
 */
import type { LatLng, RoadRoute, RoutingProvider, TravelMatrix } from '../src/services/routing.js';

const M_PER_DEG = 111_000;
const SPEED_MS = 30_000 / 3600; // 30 km/h

const legLength = (a: LatLng, b: LatLng) => Math.hypot((a.lat - b.lat) * M_PER_DEG, (a.lng - b.lng) * M_PER_DEG);
const manhattan = (a: LatLng, b: LatLng) => (Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng)) * M_PER_DEG;

function polyline(points: LatLng[]): RoadRoute {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += legLength(points[i - 1], points[i]);
  return { coordinates: points.map((p) => [p.lat, p.lng] as [number, number]), distance_m: Math.round(d), duration_s: Math.round(d / SPEED_MS) };
}

export class MockRoutingProvider implements RoutingProvider {
  readonly id = 'mock:grid-v1';
  calls = { table: 0, routes: 0 };
  /** When false, detour (via) requests find nothing. */
  allowDetours = true;
  /** When true, every call throws RoutingUnavailableError-like failure. */
  down = false;
  /** Pairs (rounded "lat,lng>lat,lng") with no road connection at all. */
  unreachable = new Set<string>();

  private check() {
    if (this.down) {
      const { RoutingUnavailableError } = require_routing();
      throw new RoutingUnavailableError('mock routing backend is down');
    }
  }

  private key(a: LatLng, b: LatLng) {
    return `${a.lat.toFixed(4)},${a.lng.toFixed(4)}>${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
  }

  async table(origins: LatLng[], destinations: LatLng[]): Promise<TravelMatrix> {
    this.check();
    this.calls.table++;
    const durations_s = origins.map((o) => destinations.map((d) => (this.unreachable.has(this.key(o, d)) ? null : Math.round(manhattan(o, d) / SPEED_MS))));
    const distances_m = origins.map((o) => destinations.map((d) => (this.unreachable.has(this.key(o, d)) ? null : Math.round(manhattan(o, d)))));
    return { durations_s, distances_m };
  }

  async routes(from: LatLng, to: LatLng, opts: { alternatives: boolean; via?: LatLng }): Promise<RoadRoute[]> {
    this.check();
    this.calls.routes++;
    if (this.unreachable.has(this.key(from, to))) return [];
    if (opts.via) return this.allowDetours ? [polyline([from, opts.via, to])] : [];
    const first = polyline([from, { lat: from.lat, lng: to.lng }, to]);
    const second = polyline([from, { lat: to.lat, lng: from.lng }, to]);
    return opts.alternatives ? [first, second] : [first];
  }
}

// Lazy import avoids a cycle at module load in the test scripts.
let routingMod: typeof import('../src/services/routing.js') | null = null;
function require_routing() {
  if (!routingMod) throw new Error('call loadRoutingModule() first');
  return routingMod;
}
export async function loadRoutingModule() {
  routingMod = await import('../src/services/routing.js');
  return routingMod;
}
