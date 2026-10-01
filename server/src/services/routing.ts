import crypto from 'node:crypto';

/**
 * Shared road-routing service. The allocation optimizer, the coordinator map and the field-unit
 * screen all use this module, so they see the same road ETA.
 *
 * Backends implement RoutingProvider. OSRM is the initial backend (ROUTING_URL); a self-hosted
 * OSRM is preferred over the public demo server, and Valhalla (which supports excluding areas
 * natively) can replace it later without touching the optimizer.
 *
 * There is deliberately NO straight-line fallback: when routing fails, callers get
 * RoutingUnavailableError and must report a degraded state instead of inventing an ETA.
 */

export interface LatLng { lat: number; lng: number }

export interface RoadRoute {
  /** [lat, lng] pairs along the road. */
  coordinates: [number, number][];
  distance_m: number;
  duration_s: number;
}

export interface TravelMatrix {
  /** durations_s[i][j]: origin i → destination j, null when no road route exists. */
  durations_s: (number | null)[][];
  distances_m: (number | null)[][];
}

export interface RoutingProvider {
  /** Identifies backend + version; part of every cache key. */
  readonly id: string;
  table(origins: LatLng[], destinations: LatLng[]): Promise<TravelMatrix>;
  /** Fastest route first; alternatives when requested; optional intermediate waypoint. */
  routes(from: LatLng, to: LatLng, opts: { alternatives: boolean; via?: LatLng }): Promise<RoadRoute[]>;
}

export class RoutingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingUnavailableError';
  }
}

export interface BlockedRoadLike {
  id: string;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  road_name?: string | null;
}

// ── OSRM backend ──────────────────────────────────────────────────────────────

const lngLat = (p: LatLng) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

export class OsrmProvider implements RoutingProvider {
  readonly id: string;

  constructor(private readonly baseUrl: string, private readonly timeoutMs = 8000, private readonly maxTableCoords = 90) {
    this.id = `osrm:${baseUrl.replace(/\/+$/, '')}`;
  }

  private async get(url: string): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new RoutingUnavailableError(`Routing server unreachable (${(err as Error).name})`);
    }
    const body = await res.json().catch(() => null) as Record<string, any> | null;
    if (!res.ok && body?.code !== 'NoRoute') throw new RoutingUnavailableError(`Routing server error ${res.status}`);
    if (!body) throw new RoutingUnavailableError('Routing server returned an invalid response');
    return body;
  }

  async table(origins: LatLng[], destinations: LatLng[]): Promise<TravelMatrix> {
    const durations: (number | null)[][] = origins.map(() => destinations.map(() => null));
    const distances: (number | null)[][] = origins.map(() => destinations.map(() => null));
    if (!origins.length || !destinations.length) return { durations_s: durations, distances_m: distances };
    // Chunk so a single request never exceeds the server's coordinate limit.
    const perSide = Math.max(1, Math.floor(this.maxTableCoords / 2));
    for (let oi = 0; oi < origins.length; oi += perSide) {
      for (let di = 0; di < destinations.length; di += perSide) {
        const o = origins.slice(oi, oi + perSide);
        const d = destinations.slice(di, di + perSide);
        const coords = [...o, ...d].map(lngLat).join(';');
        const src = o.map((_, i) => i).join(';');
        const dst = d.map((_, i) => o.length + i).join(';');
        const body = await this.get(`${this.baseUrl}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}&annotations=duration,distance`);
        if (body.code !== 'Ok') throw new RoutingUnavailableError(`Routing table failed (${body.code})`);
        o.forEach((_, i) => d.forEach((__, j) => {
          durations[oi + i][di + j] = body.durations?.[i]?.[j] ?? null;
          distances[oi + i][di + j] = body.distances?.[i]?.[j] ?? null;
        }));
      }
    }
    return { durations_s: durations, distances_m: distances };
  }

  async routes(from: LatLng, to: LatLng, opts: { alternatives: boolean; via?: LatLng }): Promise<RoadRoute[]> {
    const pts = [from, ...(opts.via ? [opts.via] : []), to].map(lngLat).join(';');
    const alt = opts.alternatives && !opts.via ? '3' : 'false';
    const body = await this.get(`${this.baseUrl}/route/v1/driving/${pts}?alternatives=${alt}&overview=full&geometries=geojson`);
    if (body.code === 'NoRoute') return [];
    if (body.code !== 'Ok') throw new RoutingUnavailableError(`Routing failed (${body.code})`);
    return (body.routes ?? []).map((r: any) => ({
      coordinates: (r.geometry?.coordinates ?? []).map(([lng, lat]: [number, number]) => [lat, lng] as [number, number]),
      distance_m: Math.round(r.distance ?? 0),
      duration_s: Math.round(r.duration ?? 0),
    }));
  }
}

// ── Provider selection ────────────────────────────────────────────────────────

let override: RoutingProvider | null | undefined;
let fromEnv: RoutingProvider | null | undefined;

/** The configured backend, or null when ROUTING_URL is not set (routing unavailable). */
export function getRoutingProvider(): RoutingProvider | null {
  if (override !== undefined) return override;
  if (fromEnv === undefined) {
    const url = process.env.ROUTING_URL?.trim();
    const backend = (process.env.ROUTING_BACKEND ?? 'osrm').trim();
    fromEnv = url && backend === 'osrm' ? new OsrmProvider(url, Number(process.env.ROUTING_TIMEOUT_MS ?? 8000)) : null;
  }
  return fromEnv;
}

/** Tests and benchmarks inject deterministic providers here. Pass undefined to restore the env backend. */
export function setRoutingProvider(p: RoutingProvider | null | undefined) {
  override = p;
  clearRoutingCache();
}

function requireProvider(): RoutingProvider {
  const p = getRoutingProvider();
  if (!p) throw new RoutingUnavailableError('No routing backend configured (set ROUTING_URL)');
  return p;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 20_000;
const cache = new Map<string, { at: number; value: unknown }>();

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
}

export function clearRoutingCache() {
  cache.clear();
}

/** ~11 m rounding: small GPS jitter reuses cached routes. */
const pointKey = (p: LatLng) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

/** Identifies the active blocked-road set; changes whenever a road is added, removed or edited. */
export function blockedRoadsVersion(roads: BlockedRoadLike[]): string {
  const canon = [...roads].sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => `${r.id}:${r.start_lat},${r.start_lng},${r.end_lat},${r.end_lng}`).join('|');
  return crypto.createHash('sha1').update(canon).digest('hex').slice(0, 12);
}

// ── Travel-time matrix ────────────────────────────────────────────────────────

/** Road travel times for every origin/destination pair (cached per pair). Throws RoutingUnavailableError. */
export async function travelMatrix(origins: LatLng[], destinations: LatLng[]): Promise<TravelMatrix> {
  const provider = requireProvider();
  const key = (o: LatLng, d: LatLng) => `m|${provider.id}|${pointKey(o)}|${pointKey(d)}`;
  const out: TravelMatrix = {
    durations_s: origins.map(() => destinations.map(() => null)),
    distances_m: origins.map(() => destinations.map(() => null)),
  };
  const missingO = new Set<number>();
  const missingD = new Set<number>();
  origins.forEach((o, i) => destinations.forEach((d, j) => {
    const hit = cacheGet<[number | null, number | null]>(key(o, d));
    if (hit) [out.durations_s[i][j], out.distances_m[i][j]] = hit;
    else { missingO.add(i); missingD.add(j); }
  }));
  if (missingO.size) {
    const oi = [...missingO];
    const di = [...missingD];
    const m = await provider.table(oi.map((i) => origins[i]), di.map((j) => destinations[j]));
    oi.forEach((i, a) => di.forEach((j, b) => {
      out.durations_s[i][j] = m.durations_s[a][b];
      out.distances_m[i][j] = m.distances_m[a][b];
      cacheSet(key(origins[i], destinations[j]), [m.durations_s[a][b], m.distances_m[a][b]]);
    }));
  }
  return out;
}

// ── Blocked-road geometry ─────────────────────────────────────────────────────

/** Route points within this distance of a blocked segment count as "on" it. */
const HIT_DISTANCE_M = 35;
/** A route must follow the blocked segment for this long (or half its length) to use it. */
const MIN_OVERLAP_M = 80;
const SAMPLE_STEP_M = 20;

function toLocal(origin: LatLng) {
  const kx = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  const ky = 110_540;
  return (p: LatLng) => ({ x: (p.lng - origin.lng) * kx, y: (p.lat - origin.lat) * ky });
}

/**
 * True when the route travels along the blocked segment (not merely crossing it once).
 * Route geometry is sampled every ~20 m and projected onto the segment.
 */
export function routeUsesBlockedRoad(route: [number, number][], road: BlockedRoadLike): boolean {
  const a = { lat: road.start_lat, lng: road.start_lng };
  const project = toLocal(a);
  const A = project(a);
  const B = project({ lat: road.end_lat, lng: road.end_lng });
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const len2 = abx * abx + aby * aby;
  const len = Math.sqrt(len2);
  if (len < 1) return false;
  let tMin = Infinity;
  let tMax = -Infinity;
  const consider = (p: { x: number; y: number }) => {
    const t = ((p.x - A.x) * abx + (p.y - A.y) * aby) / len2;
    if (t < 0 || t > 1) return;
    const dx = A.x + t * abx - p.x;
    const dy = A.y + t * aby - p.y;
    if (dx * dx + dy * dy <= HIT_DISTANCE_M * HIT_DISTANCE_M) {
      tMin = Math.min(tMin, t);
      tMax = Math.max(tMax, t);
    }
  };
  for (let i = 0; i < route.length; i++) {
    const p = project({ lat: route[i][0], lng: route[i][1] });
    consider(p);
    if (i + 1 < route.length) {
      const q = project({ lat: route[i + 1][0], lng: route[i + 1][1] });
      const segLen = Math.hypot(q.x - p.x, q.y - p.y);
      const steps = Math.floor(segLen / SAMPLE_STEP_M);
      for (let k = 1; k < steps; k++) consider({ x: p.x + ((q.x - p.x) * k) / steps, y: p.y + ((q.y - p.y) * k) / steps });
    }
  }
  if (tMax < tMin) return false;
  return (tMax - tMin) * len >= Math.min(MIN_OVERLAP_M, 0.5 * len);
}

function blockingRoads(route: RoadRoute, roads: BlockedRoadLike[]) {
  return roads.filter((r) => routeUsesBlockedRoad(route.coordinates, r));
}

/** Waypoints either side of a blocked segment's midpoint, used to search for a detour. */
function detourWaypoints(road: BlockedRoadLike): LatLng[] {
  const mid = { lat: (road.start_lat + road.end_lat) / 2, lng: (road.start_lng + road.end_lng) / 2 };
  const project = toLocal(mid);
  const B = project({ lat: road.end_lat, lng: road.end_lng });
  const A = project({ lat: road.start_lat, lng: road.start_lng });
  const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
  const nx = -(B.y - A.y) / len;
  const ny = (B.x - A.x) / len;
  const kx = 111_320 * Math.cos((mid.lat * Math.PI) / 180);
  const out: LatLng[] = [];
  for (const d of [Math.max(400, 0.75 * len), Math.max(900, 1.5 * len)]) {
    for (const sign of [1, -1]) out.push({ lat: mid.lat + (sign * ny * d) / 110_540, lng: mid.lng + (sign * nx * d) / kx });
  }
  return out;
}

export type VerifiedRoute =
  | { status: 'ok'; route: RoadRoute; via: 'fastest' | 'alternative' | 'detour'; avoided: string[] }
  | { status: 'blocked'; blocked_by: string[] }
  | { status: 'no_route' };

/**
 * Fastest road route that does not travel along any active blocked road.
 * Order: fastest route → OSRM alternatives → detour via waypoints beside the blocked segment.
 * If none avoids the blocked roads, the pair is reported as blocked (infeasible).
 * The detour search is a heuristic: it may miss a detour that exists (reported, never hidden).
 */
export async function verifiedRoute(from: LatLng, to: LatLng, roads: BlockedRoadLike[]): Promise<VerifiedRoute> {
  const provider = requireProvider();
  const key = `v|${provider.id}|${blockedRoadsVersion(roads)}|${pointKey(from)}|${pointKey(to)}`;
  const hit = cacheGet<VerifiedRoute>(key);
  if (hit) return hit;

  const candidates = await provider.routes(from, to, { alternatives: true });
  let result: VerifiedRoute;
  if (!candidates.length) {
    result = { status: 'no_route' };
  } else {
    const blockedBy = new Set<string>();
    let found: VerifiedRoute | null = null;
    for (const [i, r] of candidates.entries()) {
      const hits = blockingRoads(r, roads);
      if (!hits.length) { found = { status: 'ok', route: r, via: i === 0 ? 'fastest' : 'alternative', avoided: [...blockedBy] }; break; }
      hits.forEach((h) => blockedBy.add(h.id));
    }
    if (!found) {
      let best: RoadRoute | null = null;
      for (const road of roads.filter((r) => blockedBy.has(r.id))) {
        for (const via of detourWaypoints(road)) {
          const [r] = await provider.routes(from, to, { alternatives: false, via });
          if (r && !blockingRoads(r, roads).length && (!best || r.duration_s < best.duration_s)) best = r;
        }
        if (best) break;
      }
      found = best ? { status: 'ok', route: best, via: 'detour', avoided: [...blockedBy] } : { status: 'blocked', blocked_by: [...blockedBy] };
    }
    result = found;
  }
  cacheSet(key, result);
  return result;
}
