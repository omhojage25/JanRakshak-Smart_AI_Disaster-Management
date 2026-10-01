import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  AlertTriangle, Check, CheckCircle2, FilePlus2, MapPin, Navigation, Radio, Users, HeartPulse,
} from 'lucide-react';
import { useAuth } from '../store/useAuth';
import { useStore } from '../store/useStore';
import { fetchRoute, shareLocation, updateAssignment } from '../lib/data';
import {
  INCIDENT_TYPE_CONFIG, RESOURCE_TYPE_CONFIG, STATUS_CONFIG, formatDistance, publicPlaceName, formatTimeAgo, haversineDistance, locationQuality,
} from '../utils/helpers';
import { Button, Callout, SeverityBadge, Spinner } from '../components/ui/primitives';
import { cx } from '../utils/cx';
import type { AssignmentStatus, Incident, IncidentStatus, Resource, RoadRoute } from '../types';

const SHARE_PREF = 'jr_share_location';
const ACTIVE_ASSIGNMENT: AssignmentStatus[] = ['dispatched', 'en_route', 'arrived'];

/** Progress shown to the unit. The last stage is set by the coordinator (incident contained/resolved), not the unit. */
const FIELD_STAGES = ['Assigned', 'En route', 'Arrived', 'Contained / completed'] as const;

function fieldStage(assignment: AssignmentStatus, incident: IncidentStatus): number {
  if (incident === 'contained' || incident === 'resolved' || incident === 'closed') return 3;
  if (assignment === 'arrived') return 2;
  if (assignment === 'en_route') return 1;
  return 0;
}

const MIN_INTERVAL_MS = 10_000;
const HEARTBEAT_MS = 60_000;
const MIN_MOVE_KM = 0.025;

function useLocationSharing(resourceId: string | null) {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(SHARE_PREF) === 'on';
    } catch {
      return false;
    }
  });
  const [lastSent, setLastSent] = useState<{ at: number; accuracy: number } | null>(null);
  const [error, setError] = useState('');
  const last = useRef<{ at: number; lat: number; lng: number } | null>(null);
  const unsupported = !('geolocation' in navigator)
    ? 'This device does not provide GPS location.'
    : !window.isSecureContext
      ? 'Browsers only share GPS on HTTPS sites. Open the app over HTTPS to enable tracking.'
      : '';

  useEffect(() => {
    try {
      localStorage.setItem(SHARE_PREF, enabled ? 'on' : 'off');
    } catch {
      // ignore
    }
    if (!enabled || !resourceId || unsupported) return;

    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        const prev = last.current;
        const now = Date.now();
        const moved = prev ? haversineDistance(prev.lat, prev.lng, lat, lng) : Infinity;
        const due = !prev || (now - prev.at >= MIN_INTERVAL_MS && moved >= MIN_MOVE_KM) || now - prev.at >= HEARTBEAT_MS;
        if (!due) return;
        last.current = { at: now, lat, lng };
        shareLocation(resourceId, lat, lng, accuracy)
          .then(() => {
            setLastSent({ at: now, accuracy });
            setError('');
          })
          .catch((err) => setError(`Could not upload position: ${(err as Error).message}`));
      },
      (err) => {
        setError(err.code === err.PERMISSION_DENIED
          ? 'Location permission was denied. Allow it in the browser’s site settings.'
          : 'Waiting for a GPS fix…');
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [enabled, resourceId, unsupported]);

  return { enabled, setEnabled, lastSent, error: enabled && unsupported ? unsupported : error };
}

export function FieldPage() {
  const user = useAuth((s) => s.user)!;
  const resources = useStore((s) => s.resources);
  const assignments = useStore((s) => s.assignments);
  const incidents = useStore((s) => s.incidents);
  const loaded = useStore((s) => s.loaded);
  // Admins can act for any unit that has an active job; field users only ever act for their own linked unit.
  const isAdmin = user.role === 'admin';
  const [pickedUnitId, setPickedUnitId] = useState<string | null>(null);
  const busyUnits = useMemo(() => {
    if (!isAdmin) return [];
    const ids = new Set(assignments.filter((a) => ACTIVE_ASSIGNMENT.includes(a.status)).map((a) => a.resource_id));
    return resources.filter((r) => ids.has(r.id));
  }, [isAdmin, assignments, resources]);
  const unitId = user.resource_id
    ?? (isAdmin ? (busyUnits.some((r) => r.id === pickedUnitId) ? pickedUnitId : busyUnits[0]?.id ?? null) : null);
  const actingForOtherUnit = unitId !== user.resource_id;

  const unit = useMemo(() => resources.find((r) => r.id === unitId) ?? null, [resources, unitId]);
  const sharing = useLocationSharing(user.resource_id);
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [routeResult, setRouteResult] = useState<{ key: string; route: RoadRoute } | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, []);

  const current = useMemo(
    () => assignments.find((a) => a.resource_id === unitId && ACTIVE_ASSIGNMENT.includes(a.status)) ?? null,
    [assignments, unitId],
  );
  const incident = useMemo(() => (current ? incidents.find((i) => i.id === current.incident_id) ?? null : null), [current, incidents]);

  const fromLat = unit?.location_lat;
  const fromLng = unit?.location_lng;
  const toLat = incident?.location_lat;
  const toLng = incident?.location_lng;
  const routeKey = fromLat == null || fromLng == null || toLat == null || toLng == null || current?.status === 'arrived'
    ? null
    : `${fromLat},${fromLng}:${toLat},${toLng}`;
  const route = routeResult && routeResult.key === routeKey ? routeResult.route : null;
  useEffect(() => {
    if (!routeKey || fromLat == null || fromLng == null || toLat == null || toLng == null) return;
    let cancelled = false;
    fetchRoute([fromLat, fromLng], [toLat, toLng])
      .then((r) => { if (!cancelled) setRouteResult({ key: routeKey, route: r }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [routeKey, fromLat, fromLng, toLat, toLng]);

  if (!loaded && isAdmin && !user.resource_id) {
    return <div className="p-8 flex justify-center"><Spinner className="w-6 h-6" /></div>;
  }
  if (!unitId) {
    return (
      <div className="p-4 max-w-xl mx-auto">
        <Callout tone="info" title={isAdmin ? 'No unit is on an assignment' : 'No unit linked to your account'}>
          {isAdmin
            ? 'Units appear here once a coordinator dispatches them.'
            : 'An admin can link your field unit on the Users page.'}
        </Callout>
      </div>
    );
  }
  if (!loaded) {
    return <div className="p-8 flex justify-center"><Spinner className="w-6 h-6" /></div>;
  }

  const setStatus = async (status: 'en_route' | 'arrived') => {
    if (!current) return;
    setBusy(true);
    setActionError('');
    try {
      await updateAssignment(current.id, status);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const typeCfg = unit ? RESOURCE_TYPE_CONFIG[unit.type] : null;
  const etaMin = route ? Math.max(1, Math.round(route.duration_s / 60)) : current?.eta_minutes ?? null;
  const distance = route ? formatDistance(route.distance_m) : null;

  return (
    <div className="p-3 sm:p-4 max-w-xl mx-auto space-y-3 pb-8">
      {isAdmin && busyUnits.length > 0 && (
        <label className="flex items-center gap-2 bg-bg-card border border-border rounded-xl px-4 py-3 text-xs text-text-muted">
          <span className="flex-shrink-0">Acting for unit</span>
          <select
            value={unitId}
            onChange={(e) => setPickedUnitId(e.target.value)}
            className="flex-1 min-w-0 bg-bg-inset border border-border rounded-lg px-2 py-2 text-sm text-text focus:outline-none focus:border-accent"
          >
            {user.resource_id && !busyUnits.some((r) => r.id === user.resource_id) && unit && <option value={unit.id}>{unit.name}</option>}
            {busyUnits.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      )}

      <div className="flex items-center gap-3 px-1">
        <span className="text-2xl" aria-hidden>{typeCfg?.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{unit?.name ?? 'Unknown unit'}</div>
          <div className="text-xs text-text-dim">{typeCfg?.label}</div>
        </div>
        <span className={cx('text-[11px] font-semibold px-2 py-1 rounded-md border capitalize',
          unit?.status === 'available' ? 'text-success border-success/40' : 'text-sky-300 border-sky-400/40')}>
          {unit?.status.replace('_', ' ')}
        </span>
      </div>

      {!current || !incident ? (
        <div className="rounded-xl border border-border bg-bg-card p-6 text-center space-y-1">
          <CheckCircle2 className="w-8 h-8 text-text-dim mx-auto" />
          <div className="text-sm font-medium">No active assignment</div>
          <p className="text-xs text-text-dim">Your assignment appears here as soon as a coordinator dispatches your unit.</p>
        </div>
      ) : (
        <AssignmentView
          incident={incident}
          unit={unit}
          status={current.status}
          route={route}
          etaMin={etaMin}
          etaFromDispatch={!route}
          distance={distance}
          busy={busy}
          error={actionError}
          onStatus={setStatus}
        />
      )}

      {actingForOtherUnit ? (
        <p className="text-[11px] text-text-dim px-1">You are updating this unit's status as admin. Live location comes from the unit's own device.</p>
      ) : (
        <div className="rounded-xl border border-border bg-bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Radio className={cx('w-5 h-5 flex-shrink-0', sharing.enabled ? 'text-success' : 'text-text-dim')} />
              <div className="min-w-0">
                <div className="text-sm font-medium">Share live location</div>
                <div className="text-[11px] text-text-dim truncate">
                  {sharing.enabled
                    ? sharing.lastSent ? `Last sent ${formatTimeAgo(new Date(sharing.lastSent.at).toISOString()).toLowerCase()} · ±${Math.round(sharing.lastSent.accuracy)} m` : 'Waiting for GPS…'
                    : 'The control room sees your position on the live map'}
                </div>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={sharing.enabled}
              aria-label="Share live location"
              onClick={() => sharing.setEnabled(!sharing.enabled)}
              className={cx('relative w-12 h-7 rounded-full transition-colors cursor-pointer flex-shrink-0', sharing.enabled ? 'bg-success' : 'bg-border-light')}
            >
              <span className={cx('absolute top-1 w-5 h-5 rounded-full bg-white transition-all', sharing.enabled ? 'left-6' : 'left-1')} />
            </button>
          </div>
          {sharing.enabled && <p className="text-[11px] text-text-dim mt-2">Keep this screen open: phones pause location updates when the browser is in the background.</p>}
          {sharing.error && <p className="text-xs text-warning mt-2 flex items-start gap-1"><AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />{sharing.error}</p>}
        </div>
      )}

      <Link to="/report" className="flex items-center justify-center gap-2 w-full px-4 py-3 min-h-12 rounded-xl border border-border bg-bg-card text-sm font-medium hover:border-accent">
        <FilePlus2 className="w-4 h-4" /> Report a new incident
      </Link>
    </div>
  );
}

function AssignmentView({ incident, unit, status, route, etaMin, etaFromDispatch, distance, busy, error, onStatus }: {
  incident: Incident; unit: Resource | null; status: AssignmentStatus; route: RoadRoute | null; etaMin: number | null; etaFromDispatch: boolean;
  distance: string | null; busy: boolean; error: string; onStatus: (s: 'en_route' | 'arrived') => void;
}) {
  const type = INCIDENT_TYPE_CONFIG[incident.type];
  const stage = fieldStage(status, incident.status);
  const q = locationQuality(incident);
  const hasCoords = incident.location_lat != null && incident.location_lng != null;
  const vulnerable = [incident.has_children && 'children', incident.has_elderly && 'elderly people', incident.has_disabled && 'people with disabilities'].filter(Boolean) as string[];

  return (
    <>
      <section className="rounded-xl border border-border bg-bg-card overflow-hidden" aria-labelledby="assignment">
        <div className="p-4 space-y-2 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">Current assignment</span>
            <span className="ml-auto"><SeverityBadge priority={incident.priority} size="md" /></span>
          </div>
          <h1 id="assignment" className="text-lg font-semibold leading-snug flex items-start gap-2">
            <span aria-hidden>{type.icon}</span> {incident.title}
          </h1>
          <div className="text-sm text-text-muted flex items-center gap-1.5"><MapPin className="w-4 h-4 flex-shrink-0 text-text-dim" /> {publicPlaceName(incident.location_name) ?? 'Location on map'}</div>
          <div className="flex gap-4 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {incident.people_affected} affected</span>
            <span className="inline-flex items-center gap-1"><HeartPulse className="w-3.5 h-3.5" /> {incident.injuries} injured</span>
          </div>
          {q.needsVerification || q.tone === 'warn' ? (
            <Callout tone="warning" title={q.label}>{q.explanation} Confirm the exact spot on arrival.</Callout>
          ) : null}
        </div>

        {status !== 'arrived' && (
          <div className="grid grid-cols-2 divide-x divide-border border-b border-border">
            <div className="p-4">
              <div className="text-[10px] uppercase tracking-wide text-text-dim">ETA</div>
              <div className="text-2xl font-semibold tabular-nums mt-0.5">{etaMin != null ? `${etaMin} min` : '—'}</div>
              <div className="text-[10px] text-text-dim">{etaMin == null ? 'No route yet' : etaFromDispatch ? 'Estimated at dispatch' : 'By road, from your position'}</div>
            </div>
            <div className="p-4">
              <div className="text-[10px] uppercase tracking-wide text-text-dim">Distance</div>
              <div className="text-2xl font-semibold tabular-nums mt-0.5">{distance ?? '—'}</div>
              <div className="text-[10px] text-text-dim">{distance ? 'By road' : 'Needs your GPS position'}</div>
            </div>
          </div>
        )}

        {hasCoords && <FieldMap incident={incident} unit={unit} route={status === 'arrived' ? null : route} />}

        {hasCoords && (
          <div className="p-3">
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${incident.location_lat},${incident.location_lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 min-h-12 rounded-xl border border-accent/60 text-blue-200 font-medium hover:bg-accent/10"
            >
              <Navigation className="w-5 h-5" /> Open navigation
            </a>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-bg-card p-4 space-y-4" aria-labelledby="status">
        <div className="flex items-center gap-2">
          <h2 id="status" className="text-sm font-semibold">Status</h2>
          <span className="ml-auto text-[11px] text-text-dim">Incident: <span style={{ color: STATUS_CONFIG[incident.status].color }}>{STATUS_CONFIG[incident.status].label}</span></span>
        </div>
        <ol className="space-y-0">
          {FIELD_STAGES.map((label, i) => {
            const done = i < stage;
            const cur = i === stage;
            return (
              <li key={label} className="flex gap-3" aria-current={cur ? 'step' : undefined}>
                <div className="flex flex-col items-center">
                  <span className={cx('w-6 h-6 rounded-full border-2 flex items-center justify-center',
                    done ? 'bg-success border-success text-white' : cur ? 'border-accent bg-accent/15' : 'border-border')}>
                    {done ? <Check className="w-3.5 h-3.5" /> : cur ? <span className="w-2 h-2 rounded-full bg-accent" /> : null}
                  </span>
                  {i < FIELD_STAGES.length - 1 && <span className={cx('w-0.5 h-5', done ? 'bg-success' : 'bg-border')} />}
                </div>
                <span className={cx('text-sm pt-0.5', cur ? 'font-semibold text-text' : done ? 'text-text-muted' : 'text-text-dim')}>{label}</span>
              </li>
            );
          })}
        </ol>

        {status === 'dispatched' && (
          <Button variant="primary" size="lg" className="w-full" busy={busy} onClick={() => onStatus('en_route')}>Mark en route</Button>
        )}
        {status === 'en_route' && (
          <Button variant="success" size="lg" className="w-full" busy={busy} onClick={() => onStatus('arrived')}>Arrived at incident</Button>
        )}
        {status === 'dispatched' && (
          <Button variant="ghost" size="sm" className="w-full" disabled={busy} onClick={() => onStatus('arrived')}>Already on scene? Mark arrived</Button>
        )}
        {status === 'arrived' && (
          <p className="text-xs text-text-muted">You are on scene. The coordinator marks the incident contained and completed; it updates here automatically.</p>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </section>

      {(incident.urgency_indicators?.length > 0 || vulnerable.length > 0 || incident.description) && (
        <section className="rounded-xl border border-border bg-bg-card p-4 space-y-2" aria-label="Incident details">
          <h2 className="text-sm font-semibold">Incident details</h2>
          {incident.description && <p className="text-sm text-text-muted">{incident.description}</p>}
          {vulnerable.length > 0 && <p className="text-sm text-red-300">Vulnerable people reported: {vulnerable.join(', ')}.</p>}
          {incident.urgency_indicators?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {incident.urgency_indicators.map((u) => <span key={u} className="text-xs px-2 py-0.5 rounded bg-warning/10 text-warning border border-warning/25">{u}</span>)}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function FitRoute({ points }: { points: [number, number][] }) {
  const map = useMap();
  const key = points.map((p) => p.join(',')).join('|');
  const fit = useRef<() => void>(() => {});
  useEffect(() => {
    fit.current = () => {
      if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 16, animate: false });
      else if (points.length === 1) map.setView(points[0], 15, { animate: false });
    };
    fit.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refit only when the set of points changes
  }, [map, key]);
  // Leaflet measures its container once; re-measure (and refit) when the card finishes laying out or resizes.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
      fit.current();
    });
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return null;
}

function FieldMap({ incident, unit, route }: { incident: Incident; unit: Resource | null; route: RoadRoute | null }) {
  const to: [number, number] = [incident.location_lat!, incident.location_lng!];
  const from: [number, number] | null = unit?.location_lat != null && unit.location_lng != null ? [unit.location_lat, unit.location_lng] : null;
  const incIcon = useMemo(() => L.divIcon({
    className: '',
    html: `<div class="jr-incident-marker" style="width:32px;height:32px;border-color:#ef4444;background:rgba(239,68,68,0.28);font-size:16px">${INCIDENT_TYPE_CONFIG[incident.type].icon}</div>`,
    iconSize: [32, 32], iconAnchor: [16, 16],
  }), [incident.type]);
  const unitIcon = useMemo(() => (unit ? L.divIcon({
    className: '', html: `<div class="jr-resource-marker" style="border-color:#38bdf8">${RESOURCE_TYPE_CONFIG[unit.type].icon}</div>`, iconSize: [24, 24], iconAnchor: [12, 12],
  }) : null), [unit]);
  const fit: [number, number][] = route ? [route.coordinates[0], to] : from ? [from, to] : [to];

  return (
    <div className="h-52 sm:h-60 border-b border-border">
      <MapContainer center={to} zoom={14} scrollWheelZoom={false} className="h-full w-full" attributionControl={false}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <FitRoute points={fit} />
        {route && <Polyline positions={route.coordinates} pathOptions={{ color: '#38bdf8', weight: 5, opacity: 0.9 }} />}
        <Marker position={to} icon={incIcon} />
        {from && unitIcon && <Marker position={from} icon={unitIcon} />}
      </MapContainer>
    </div>
  );
}
