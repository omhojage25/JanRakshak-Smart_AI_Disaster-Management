import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Construction, Crosshair, Layers, ListTree, Trash2, X } from 'lucide-react';
import { useStore, isActiveStatus, type MapLayers } from '../../store/useStore';
import { addBlockedRoad, removeBlockedRoad } from '../../lib/data';
import {
  INCIDENT_TYPE_CONFIG, PRIORITY_CONFIG, RESOURCE_TYPE_CONFIG, formatTimeAgo, locationQuality,
} from '../../utils/helpers';
import type { BlockedRoad, Incident, Priority, Resource } from '../../types';
import { Button } from '../ui/primitives';
import { cx } from '../../utils/cx';
import { useConfirm } from '../ui/ConfirmDialog';
import { RouteLines } from './RouteLines';

type Located<T> = T & { location_lat: number; location_lng: number };

/** Marker size by severity: only critical incidents are large and pulsing. */
const MARKER_SIZE: Record<Priority, number> = { critical: 38, high: 32, medium: 27, low: 23 };
const iconCache = new Map<string, L.DivIcon>();

function incidentIcon(incident: Incident, selected: boolean, uncertain: boolean) {
  const key = `i:${incident.type}:${incident.priority}:${selected}:${uncertain}`;
  let icon = iconCache.get(key);
  if (!icon) {
    const p = PRIORITY_CONFIG[incident.priority];
    const size = MARKER_SIZE[incident.priority];
    const cls = ['jr-incident-marker', incident.priority === 'critical' && 'jr-critical', selected && 'jr-selected', uncertain && 'jr-uncertain'].filter(Boolean).join(' ');
    icon = L.divIcon({
      className: '',
      html: `<div style="position:relative;width:${size}px;height:${size}px"><div class="${cls}" style="width:${size}px;height:${size}px;border-color:${p.color};background:${p.bg.replace('0.14', '0.3')};font-size:${Math.round(size * 0.5)}px">${INCIDENT_TYPE_CONFIG[incident.type].icon}</div>${uncertain ? '<span class="jr-marker-flag" title="Location uncertain">?</span>' : ''}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      tooltipAnchor: [0, -size / 2],
    });
    iconCache.set(key, icon);
  }
  return icon;
}

type UnitState = 'available' | 'responding' | 'off';

function resourceIcon(resource: Resource, state: UnitState, live: boolean) {
  const key = `r:${resource.type}:${state}:${live}`;
  let icon = iconCache.get(key);
  if (!icon) {
    const cfg = RESOURCE_TYPE_CONFIG[resource.type];
    const cls = ['jr-resource-marker', state === 'available' && 'jr-idle', state === 'off' && 'jr-off', live && state === 'responding' && 'jr-live'].filter(Boolean).join(' ');
    const border = state === 'available' ? '#22c55e' : state === 'responding' ? '#38bdf8' : '#475569';
    icon = L.divIcon({
      className: '',
      html: `<div class="${cls}" style="border-color:${border}">${cfg.icon}${live && state === 'responding' ? '<span class="jr-live-badge">LIVE</span>' : ''}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -14],
    });
    iconCache.set(key, icon);
  }
  return icon;
}

const pointIcon = L.divIcon({ className: '', html: '<div class="jr-point-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });

function unitState(r: Resource): UnitState {
  if (r.status === 'available') return 'available';
  if (r.status === 'unavailable') return 'off';
  return 'responding';
}

function MapController() {
  const map = useMap();
  const lat = useStore((s) => s.mapCenterLat);
  const lng = useStore((s) => s.mapCenterLng);
  const zoom = useStore((s) => s.mapZoom);
  const prevRef = useRef({ lat, lng });

  useEffect(() => {
    if (prevRef.current.lat !== lat || prevRef.current.lng !== lng) {
      prevRef.current = { lat, lng };
      // A hidden map (mobile tab not shown) has no size; animating it yields NaN coordinates, so jump instead.
      const size = map.getSize();
      if (size.x > 0 && size.y > 0) map.flyTo([lat, lng], zoom, { duration: 0.8 });
      else map.setView([lat, lng], zoom, { animate: false });
    }
  }, [lat, lng, zoom, map]);

  // Leaflet measures its container once; re-measure when the layout around it changes size.
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);

  return null;
}

function ClickCapture({ active, onClick }: { active: boolean; onClick: (lat: number, lng: number) => void }) {
  const map = useMapEvents({ click: (e) => { if (active) onClick(e.latlng.lat, e.latlng.lng); } });
  useEffect(() => {
    map.getContainer().classList.toggle('jr-picking', active);
  }, [map, active]);
  return null;
}

const LAYER_LABELS: Record<keyof MapLayers, string> = {
  zones: 'Affected zones',
  resources: 'Units & facilities',
  routes: 'Routes',
  roads: 'Blocked roads',
};

type RoadDraft = { step: 'start' } | { step: 'end'; a: [number, number] } | { step: 'details'; a: [number, number]; b: [number, number] };

export function SituationMap() {
  const allIncidents = useStore((s) => s.incidents);
  const allResources = useStore((s) => s.resources);
  const blockedRoads = useStore((s) => s.blockedRoads);
  const layers = useStore((s) => s.mapLayers);
  const selectedId = useStore((s) => s.selectedIncidentId);
  const selectAndFlyTo = useStore((s) => s.selectAndFlyTo);
  const mapPick = useStore((s) => s.mapPick);
  const startMapPick = useStore((s) => s.startMapPick);
  const completeMapPick = useStore((s) => s.completeMapPick);
  const mapCenterLat = useStore((s) => s.mapCenterLat);
  const mapCenterLng = useStore((s) => s.mapCenterLng);
  const mapZoom = useStore((s) => s.mapZoom);
  const [draft, setDraft] = useState<RoadDraft | null>(null);
  const { confirm, dialog } = useConfirm();
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // Esc cancels whichever map interaction is in progress.
  useEffect(() => {
    if (!draft && !mapPick) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDraft(null);
      if (mapPick) startMapPick(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, mapPick, startMapPick]);

  const incidents = useMemo(() => allIncidents.filter((i): i is Located<Incident> =>
    isActiveStatus(i.status) && !i.parent_incident_id && i.location_lat != null && i.location_lng != null,
  ), [allIncidents]);
  const resources = useMemo(() => allResources.filter((r): r is Located<Resource> =>
    r.location_lat != null && r.location_lng != null,
  ), [allResources]);

  const onMapClick = (lat: number, lng: number) => {
    if (mapPick) {
      completeMapPick(lat, lng);
      return;
    }
    if (draft?.step === 'start') setDraft({ step: 'end', a: [lat, lng] });
    else if (draft?.step === 'end') setDraft({ step: 'details', a: draft.a, b: [lat, lng] });
  };

  const removeRoad = async (road: BlockedRoad) => {
    const ok = await confirm({
      title: 'Reopen this road?',
      body: 'Routing will use this road again and the optimizer will re-plan affected units. Proposals still need approval.',
      confirmLabel: 'Remove block',
      tone: 'warning',
    });
    if (!ok) return;
    await removeBlockedRoad(road.id).catch((err) => useStore.getState().pushToast({
      id: `road-${road.id}`, type: 'warning', title: 'Could not remove the road block', message: (err as Error).message,
    }));
  };

  return (
    <div className="relative w-full h-full">
      <MapContainer center={[mapCenterLat, mapCenterLng]} zoom={mapZoom} className="w-full h-full" zoomControl attributionControl>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        />
        <MapController />
        <ClickCapture active={!!mapPick || (!!draft && draft.step !== 'details')} onClick={onMapClick} />

        {incidents.map((incident) => {
          const q = locationQuality(incident);
          const acc = incident.location_meta?.accuracy_m;
          const selected = incident.id === selectedId;
          const pCfg = PRIORITY_CONFIG[incident.priority];
          return (
            <Fragment key={`z-${incident.id}`}>
              {layers.zones && (
                <Circle
                  center={[incident.location_lat, incident.location_lng]}
                  radius={incident.affected_radius_m}
                  pathOptions={{ color: pCfg.color, fillColor: pCfg.color, fillOpacity: selected ? 0.1 : 0.06, weight: selected ? 1.5 : 0.75, opacity: 0.6 }}
                  interactive={false}
                />
              )}
              {/* Uncertainty ring: the real accuracy radius from location resolution, drawn so a vague location never looks precise. */}
              {(q.needsVerification || q.tone === 'warn') && acc != null && acc > incident.affected_radius_m && (
                <Circle
                  center={[incident.location_lat, incident.location_lng]}
                  radius={acc}
                  pathOptions={{ color: '#eab308', weight: 1.25, opacity: 0.7, dashArray: '5 6', fillOpacity: 0.03 }}
                  interactive={false}
                />
              )}
            </Fragment>
          );
        })}

        {layers.roads && blockedRoads.map((road) => (
          <Polyline
            key={road.id}
            positions={[[road.start_lat, road.start_lng], [road.end_lat, road.end_lng]]}
            pathOptions={{ color: '#f87171', weight: 5, dashArray: '1 9', lineCap: 'round', opacity: 0.95 }}
          >
            <Tooltip sticky>Road blocked{road.road_name ? `: ${road.road_name}` : ''}</Tooltip>
            <Popup>
              <div className="min-w-[180px] space-y-1">
                <div className="text-xs font-semibold text-red-300 flex items-center gap-1"><Construction className="w-3.5 h-3.5" /> Road blocked</div>
                {road.road_name && <div className="text-xs">{road.road_name}</div>}
                {road.reason && <div className="text-[11px] text-text-muted">{road.reason}</div>}
                <div className="text-[10px] text-text-dim">Since {formatTimeAgo(road.created_at)}</div>
                <button type="button" onClick={() => removeRoad(road)} className="mt-1 inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text cursor-pointer">
                  <Trash2 className="w-3 h-3" /> Remove block
                </button>
              </div>
            </Popup>
          </Polyline>
        ))}

        {layers.routes && <RouteLines />}

        {incidents.map((incident) => {
          const q = locationQuality(incident);
          const selected = incident.id === selectedId;
          return (
            <Marker
              key={`inc-${incident.id}`}
              position={[incident.location_lat, incident.location_lng]}
              icon={incidentIcon(incident, selected, q.needsVerification)}
              zIndexOffset={selected ? 2000 : incident.priority === 'critical' ? 1000 : incident.priority === 'high' ? 500 : 0}
              keyboard
              title={`${PRIORITY_CONFIG[incident.priority].label}: ${incident.title}`}
              eventHandlers={{ click: () => { if (!mapPick && !draft) selectAndFlyTo(incident.id, incident.location_lat, incident.location_lng); } }}
            >
              <Tooltip direction="top" offset={[0, -4]}>
                <span style={{ color: PRIORITY_CONFIG[incident.priority].color, fontWeight: 700 }}>{PRIORITY_CONFIG[incident.priority].label.toUpperCase()}</span>
                {' · '}{incident.title}
                {q.needsVerification && <span style={{ color: '#eab308' }}> · location unverified</span>}
              </Tooltip>
            </Marker>
          );
        })}

        {layers.resources && resources.map((resource) => {
          const live = !!(resource.location_updated_at && Date.now() - new Date(resource.location_updated_at).getTime() < 5 * 60_000);
          const state = unitState(resource);
          return (
            <Marker
              key={`res-${resource.id}`}
              position={[resource.location_lat, resource.location_lng]}
              icon={resourceIcon(resource, state, live)}
              zIndexOffset={state === 'responding' ? 400 : -100}
            >
              <Tooltip direction="top" offset={[0, -10]}>{resource.name}</Tooltip>
              <Popup><ResourcePopup resource={resource} live={live} /></Popup>
            </Marker>
          );
        })}

        {draft && draft.step !== 'start' && <Marker position={draft.a} icon={pointIcon} interactive={false} />}
        {draft?.step === 'details' && (
          <>
            <Marker position={draft.b} icon={pointIcon} interactive={false} />
            <Polyline positions={[draft.a, draft.b]} pathOptions={{ color: '#eab308', weight: 4, dashArray: '1 8', lineCap: 'round' }} />
          </>
        )}
      </MapContainer>

      <MapToolbar
        drawing={!!draft}
        onBlockRoad={() => { startMapPick(null); setDraft(draft ? null : { step: 'start' }); }}
      />
      <MapLegend />

      {(mapPick || (draft && draft.step !== 'details')) && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-3 pl-3 pr-1.5 py-1.5 rounded-lg bg-bg-card border border-warning/50 shadow-xl text-xs max-w-[92%]">
          <Crosshair className="w-4 h-4 text-warning flex-shrink-0" />
          <span className="text-text">
            {mapPick ? 'Click the map at the correct incident location'
              : draft?.step === 'start' ? 'Click the start of the blocked stretch of road' : 'Now click the end of the blocked stretch'}
          </span>
          <Button size="sm" variant="ghost" onClick={() => { setDraft(null); startMapPick(null); }} aria-label="Cancel">
            <X className="w-3.5 h-3.5" /> Cancel
          </Button>
        </div>
      )}

      {draft?.step === 'details' && (
        <BlockedRoadForm a={draft.a} b={draft.b} onDone={() => setDraft(null)} />
      )}
      {dialog}
    </div>
  );
}

function MapToolbar({ drawing, onBlockRoad }: { drawing: boolean; onBlockRoad: () => void }) {
  const layers = useStore((s) => s.mapLayers);
  const toggle = useStore((s) => s.toggleLayer);
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute top-3 right-3 z-[1000] flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBlockRoad}
          aria-pressed={drawing}
          className={cx('flex items-center gap-1.5 text-xs font-medium px-2.5 py-2 rounded-lg border shadow-lg cursor-pointer',
            drawing ? 'bg-warning/15 border-warning/60 text-warning' : 'bg-bg-card/95 border-border text-text-muted hover:text-text')}
          title="Mark a stretch of road as blocked"
        >
          <Construction className="w-4 h-4" /> <span className="hidden sm:inline">{drawing ? 'Cancel' : 'Block road'}</span>
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-2 rounded-lg border shadow-lg cursor-pointer bg-bg-card/95 border-border text-text-muted hover:text-text"
        >
          <Layers className="w-4 h-4" /> <span className="hidden sm:inline">Layers</span>
        </button>
      </div>
      {open && (
        <div className="bg-bg-card/95 border border-border rounded-lg shadow-xl p-1.5 min-w-[180px]" role="group" aria-label="Map layers">
          {(Object.keys(LAYER_LABELS) as (keyof MapLayers)[]).map((key) => (
            <label key={key} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-card-hover text-xs cursor-pointer">
              <input type="checkbox" checked={layers[key]} onChange={() => toggle(key)} className="accent-accent w-3.5 h-3.5" />
              {LAYER_LABELS[key]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function MapLegend() {
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 1536px)').matches);
  return (
    <div className="absolute bottom-6 left-3 z-[1000] bg-bg-card/95 border border-border rounded-lg shadow-xl text-[11px]">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1.5 px-2.5 py-1.5 text-text-muted hover:text-text cursor-pointer font-medium">
        <ListTree className="w-3.5 h-3.5" /> Legend
      </button>
      {open && (
        <div className="px-3 pb-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-text-muted">
          {(['critical', 'high', 'medium', 'low'] as Priority[]).map((p) => (
            <span key={p} className="flex items-center gap-2">
              <span className="rounded-full border-2 inline-block" style={{ width: MARKER_SIZE[p] / 2.4, height: MARKER_SIZE[p] / 2.4, borderColor: PRIORITY_CONFIG[p].color }} />
              {PRIORITY_CONFIG[p].label}
            </span>
          ))}
          <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full border-2 border-dashed border-warning inline-block" /> Location unverified</span>
          <span className="flex items-center gap-2"><span className="w-3 h-3 rounded border-2 border-success inline-block" /> Unit available</span>
          <span className="flex items-center gap-2"><span className="w-3 h-3 rounded border-2 border-sky-400 inline-block" /> Unit responding</span>
          <span className="flex items-center gap-2"><span className="w-3 h-3 rounded border-2 border-slate-600 inline-block opacity-60" /> Out of service</span>
          <span className="flex items-center gap-2"><span className="w-4 h-[3px] bg-sky-400 inline-block rounded" /> Active route</span>
          <span className="flex items-center gap-2"><span className="w-4 border-t-2 border-dotted border-indigo-300 inline-block" /> Proposed route</span>
          <span className="flex items-center gap-2"><span className="w-4 border-t-[3px] border-dotted border-red-400 inline-block" /> Blocked road</span>
        </div>
      )}
    </div>
  );
}

function BlockedRoadForm({ a, b, onDone }: { a: [number, number]; b: [number, number]; onDone: () => void }) {
  const selected = useStore((s) => s.incidents.find((i) => i.id === s.selectedIncidentId) ?? null);
  const [roadName, setRoadName] = useState('');
  const [reason, setReason] = useState('');
  const [link, setLink] = useState(!!selected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await addBlockedRoad({
        start_lat: a[0], start_lng: a[1], end_lat: b[0], end_lng: b[1],
        road_name: roadName.trim() || undefined,
        reason: reason.trim() || undefined,
        incident_id: link && selected ? selected.id : undefined,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const input = 'w-full bg-bg-inset border border-border rounded-lg px-2.5 py-2 text-sm sm:text-xs focus:outline-none focus:border-accent';
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[1001] w-[min(360px,calc(100%-24px))] bg-bg-card border border-border-light rounded-xl shadow-2xl p-3 space-y-2.5">
      <div className="flex items-center gap-2 text-sm font-semibold"><Construction className="w-4 h-4 text-warning" /> Mark road blocked</div>
      <input className={input} placeholder="Road name (optional)" value={roadName} maxLength={200} onChange={(e) => setRoadName(e.target.value)} autoFocus />
      <input className={input} placeholder="Reason, e.g. waterlogging, debris" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      {selected && (
        <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
          <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} className="accent-accent" />
          Caused by: <span className="truncate text-text">{selected.title}</span>
        </label>
      )}
      <p className="text-[11px] text-text-dim">Routing will avoid this stretch and the optimizer re-plans affected units. Any change is proposed for approval, never dispatched automatically.</p>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" className="flex-1" busy={busy} onClick={save}>Block road</Button>
        <Button size="sm" onClick={onDone} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

function ResourcePopup({ resource, live }: { resource: Resource; live: boolean }) {
  const cfg = RESOURCE_TYPE_CONFIG[resource.type];
  const capPct = resource.capacity > 1 ? Math.round((resource.current_load / resource.capacity) * 100) : null;
  return (
    <div className="min-w-[180px] space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-lg" aria-hidden>{cfg.icon}</span>
        <div>
          <div className="text-xs font-semibold">{resource.name}</div>
          <div className="text-[10px] text-text-dim">{cfg.label}</div>
        </div>
      </div>
      <div className="text-[11px] flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: resource.status === 'available' ? '#22c55e' : resource.status === 'unavailable' ? '#64748b' : '#38bdf8' }} />
        <span className="text-text-muted capitalize">{resource.status.replace('_', ' ')}</span>
      </div>
      {capPct !== null && <div className="text-[10px] text-text-dim">Capacity: {resource.current_load}/{resource.capacity} ({capPct}%)</div>}
      {resource.capabilities.length > 0 && <div className="text-[10px] text-text-dim">{resource.capabilities.map((c) => c.replace(/_/g, ' ')).join(' · ')}</div>}
      {live && resource.location_updated_at ? (
        <div className="text-[10px] text-success">
          Live GPS {formatTimeAgo(resource.location_updated_at)}{resource.location_accuracy_m != null ? ` · ±${Math.round(resource.location_accuracy_m)} m` : ''}
        </div>
      ) : resource.location_name && <div className="text-[10px] text-text-dim">Last known: {resource.location_name}</div>}
    </div>
  );
}
