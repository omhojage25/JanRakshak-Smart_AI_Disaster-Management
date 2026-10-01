import { useMemo, useState, useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { RESOURCE_TYPE_CONFIG, capacityColor } from '../../utils/helpers';
import type { Resource, ResourceType } from '../../types';

const MOBILE_TYPES: ResourceType[] = ['ambulance', 'fire_truck', 'police', 'road_crew'];

function isLiveLocation(r: Resource): boolean {
  return !!(r.location_updated_at && (Date.now() - new Date(r.location_updated_at).getTime()) < 5 * 60_000);
}

export function ResourcePanel() {
  const resources = useStore((s) => s.resources);
  const incidents = useStore((s) => s.incidents);
  const selectAndFlyTo = useStore((s) => s.selectAndFlyTo);
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const byType = useMemo(() => resources.reduce<Record<string, Resource[]>>((acc, r) => {
    (acc[r.type] ??= []).push(r);
    return acc;
  }, {}), [resources]);

  const vehicles = resources.filter((r) => MOBILE_TYPES.includes(r.type));
  const available = vehicles.filter((r) => r.status === 'available').length;
  const deployed = vehicles.filter((r) => ['dispatched', 'en_route', 'on_scene'].includes(r.status)).length;
  const bedsFree = resources.filter((r) => r.type === 'hospital').reduce((s, r) => s + Math.max(0, r.capacity - r.current_load), 0);

  return (
    <div className="space-y-3">
      <div className="bg-bg-inset border border-border rounded-lg p-3">
        <div className="text-xs text-text-muted mb-2">Resource overview</div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div><div className="text-lg font-bold text-success">{available}</div><div className="text-[10px] text-text-dim">Units free</div></div>
          <div><div className="text-lg font-bold text-accent">{deployed}</div><div className="text-[10px] text-text-dim">Units deployed</div></div>
          <div><div className="text-lg font-bold text-text">{bedsFree}</div><div className="text-[10px] text-text-dim">Hospital beds free</div></div>
        </div>
      </div>

      {(Object.keys(RESOURCE_TYPE_CONFIG) as ResourceType[]).map((type) => {
        const items = byType[type] || [];
        if (items.length === 0) return null;
        const cfg = RESOURCE_TYPE_CONFIG[type];
        const isFacility = type === 'hospital' || type === 'shelter';
        const unit = type === 'hospital' ? 'beds' : 'spaces';
        return (
          <div key={type} className="bg-bg-inset border border-border rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <span>{cfg.icon}</span>
              <span className="text-xs font-medium">{type === 'police' ? 'Police' : `${cfg.label}s`}</span>
              <span className="text-[10px] text-text-dim ml-auto">
                {isFacility
                  ? `${items.reduce((s, r) => s + Math.max(0, r.capacity - r.current_load), 0)} ${unit} free`
                  : `${items.filter((r) => r.status === 'available').length}/${items.length} free`}
              </span>
            </div>
            <div className="space-y-1">
              {items.map((r) => {
                const incident = r.assigned_incident_id ? incidents.find((i) => i.id === r.assigned_incident_id) : null;
                if (isFacility) {
                  const free = Math.max(0, r.capacity - r.current_load);
                  const pct = r.capacity ? Math.round((r.current_load / r.capacity) * 100) : 0;
                  return (
                    <div key={r.id} className="flex items-center gap-2 text-xs px-1 py-0.5">
                      <button
                        type="button"
                        onClick={() => r.location_lat != null && selectAndFlyTo(null, r.location_lat, r.location_lng)}
                        className="flex-1 text-left text-text-muted truncate hover:text-text cursor-pointer"
                      >
                        {r.name}
                      </button>
                      <div className="w-14 h-1.5 bg-bg rounded-full overflow-hidden" title={`${pct}% occupied`}>
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: capacityColor(pct) }} />
                      </div>
                      <span className={`text-[10px] w-20 text-right ${free === 0 ? 'text-danger' : 'text-text-dim'}`}>{free}/{r.capacity} free</span>
                    </div>
                  );
                }
                const live = isLiveLocation(r);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => r.location_lat != null && selectAndFlyTo(incident?.id ?? null, r.location_lat, r.location_lng)}
                    className="w-full flex items-center gap-2 text-xs text-left rounded hover:bg-bg-card-hover px-1 py-0.5 cursor-pointer"
                    title={incident ? `Assigned to: ${incident.title}` : undefined}
                  >
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.status === 'available' ? 'bg-success' : r.status === 'unavailable' ? 'bg-text-dim' : 'bg-accent'}`} />
                    <span className="flex-1 text-text-muted truncate">{r.name}</span>
                    {live && <span className="text-[9px] font-bold px-1 rounded whitespace-nowrap bg-success/20 text-success" title="Live GPS location">LIVE</span>}
                    {r.eta_minutes != null && (r.status === 'dispatched' || r.status === 'en_route') && (
                      <span className="text-[10px] text-text-dim whitespace-nowrap">ETA {r.eta_minutes}m</span>
                    )}
                    <span className={`text-[10px] capitalize whitespace-nowrap ${r.status === 'available' ? 'text-success' : 'text-text-dim'}`}>
                      {r.status.replace('_', ' ')}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
