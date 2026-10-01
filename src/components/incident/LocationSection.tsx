import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Crosshair, ListChecks, MapPin } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { updateIncidentLocation, type LocationAction } from '../../lib/data';
import { formatDistance, formatTimeAgo, haversineDistance, locationQuality } from '../../utils/helpers';
import { Button, Callout, LocationBadge } from '../ui/primitives';
import type { Incident, LocationMeta } from '../../types';

const SOURCE_LABEL: Record<LocationMeta['source'], string> = {
  geocoder: 'Matched on the map from the report text',
  reporter_gps: "Reporter's phone GPS",
  gazetteer: 'Known area centre (offline list)',
  ai_estimate: 'AI estimate from the report',
  city_centre: 'No location found (city placeholder)',
  coordinator: 'Set by a coordinator',
};

const GPS_LABEL: Record<LocationMeta['gps_consistency'], string | null> = {
  consistent: "Agrees with the reporter's GPS",
  conflict: "Conflicts with the reporter's GPS",
  used: "Reporter's GPS used",
  not_available: null,
};

type Pending = { lat: number; lng: number; name: string | null; label: string; action: LocationAction };

/** Location quality and the lightweight verify / correct workflow (PATCH /incidents/:id/location). */
export function LocationSection({ incident, canManage, active }: { incident: Incident; canManage: boolean; active: boolean }) {
  const meta = incident.location_meta ?? null;
  const q = locationQuality(incident);
  const startMapPick = useStore((s) => s.startMapPick);
  const mapPick = useStore((s) => s.mapPick);
  const pickedPoint = useStore((s) => s.pickedPoint);
  const clearPickedPoint = useStore((s) => s.clearPickedPoint);
  const [showCandidates, setShowCandidates] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const picking = mapPick?.incidentId === incident.id;

  // A map click chosen for this incident becomes a pending correction to confirm.
  useEffect(() => {
    if (!pickedPoint || pickedPoint.for !== incident.id) return;
    setPending({
      lat: pickedPoint.lat, lng: pickedPoint.lng, name: incident.location_name, label: 'Point chosen on the map',
      action: { action: 'correct', lat: pickedPoint.lat, lng: pickedPoint.lng },
    });
    setName(incident.location_name ?? '');
    clearPickedPoint();
  }, [pickedPoint, incident.id, incident.location_name, clearPickedPoint]);

  // Leaving the incident cancels an unfinished map pick.
  useEffect(() => () => { if (useStore.getState().mapPick?.incidentId === incident.id) useStore.getState().startMapPick(null); }, [incident.id]);

  const submit = async (action: LocationAction) => {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const withNote = { ...action, note: note.trim() || undefined } as LocationAction;
      if (withNote.action !== 'verify' && name.trim()) (withNote as { location_name?: string }).location_name = name.trim();
      const res = await updateIncidentLocation(incident.id, withNote);
      setPending(null);
      setShowCandidates(false);
      setNote('');
      setResult(res.dedup_check !== 'new'
        ? 'Location saved. Another active incident is close by and has been flagged as a possible duplicate for review.'
        : 'Location saved. Units will be re-planned for the new position; any change is proposed for approval.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const moveM = pending && incident.location_lat != null && incident.location_lng != null
    ? haversineDistance(incident.location_lat, incident.location_lng, pending.lat, pending.lng) * 1000
    : null;
  const candidates = meta?.candidates ?? [];

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-start gap-2">
          <MapPin className="w-4 h-4 text-text-dim flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{incident.location_name ?? 'Unnamed location'}</div>
            {!q.needsVerification && <div className="mt-1"><LocationBadge quality={q} /></div>}
          </div>
        </div>
        {q.needsVerification && <Callout tone="warning" title="Location needs verification">{q.explanation} Confirm it with the reporter before relying on the pin.</Callout>}
      </div>

      {meta && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
          <Item label="Source">{SOURCE_LABEL[meta.source] ?? meta.source}</Item>
          <Item label={meta.ambiguous ? 'Accuracy (top match)' : 'Accuracy'}>±{formatDistance(meta.accuracy_m)}</Item>
          {!meta.verified && <Item label="Resolver confidence">{Math.round(meta.confidence * 100)}%</Item>}
          {GPS_LABEL[meta.gps_consistency] && <Item label="Reporter GPS">{GPS_LABEL[meta.gps_consistency]}</Item>}
          {meta.original_text && <Item label="Reporter said" wide>“{meta.original_text}”</Item>}
          {meta.verified && <Item label="Verified" wide>{meta.verified.action.replace('_', ' ')} · {formatTimeAgo(meta.verified.at)}</Item>}
        </dl>
      )}

      {result && <Callout tone="success">{result}</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}

      {pending && (
        <div className="rounded-lg border border-accent/40 bg-accent/[0.06] p-3 space-y-2.5">
          <div className="text-xs font-semibold">Confirm location change</div>
          <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-[11px]">
            <div className="min-w-0">
              <div className="text-text-dim">Current</div>
              <div className="truncate">{incident.location_name ?? '—'}</div>
              <div className="text-text-dim">{q.label}</div>
            </div>
            <ArrowRight className="w-4 h-4 text-text-dim" />
            <div className="min-w-0">
              <div className="text-text-dim">New</div>
              <div className="truncate" title={pending.label}>{shortPlace(pending.label)}</div>
              <div className="text-text-dim">{pending.lat.toFixed(5)}, {pending.lng.toFixed(5)}{moveM != null ? ` · moves ${formatDistance(moveM)}` : ''}</div>
            </div>
          </div>
          <input className="w-full bg-bg-inset border border-border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-accent" placeholder="Location name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          <input className="w-full bg-bg-inset border border-border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-accent" placeholder="Note, e.g. confirmed by phone (optional)" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" className="flex-1" busy={busy} icon={<Check className="w-3.5 h-3.5" />} onClick={() => submit(pending.action)}>Save verified location</Button>
            <Button size="sm" disabled={busy} onClick={() => setPending(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {canManage && active && !pending && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {q.precision !== 'verified' && (
              <Button size="sm" busy={busy} icon={<Check className="w-3.5 h-3.5" />} onClick={() => submit({ action: 'verify' })}>Confirm current location</Button>
            )}
            {candidates.length > 0 && (
              <Button size="sm" icon={<ListChecks className="w-3.5 h-3.5" />} onClick={() => setShowCandidates((s) => !s)} aria-expanded={showCandidates}>
                Other matches ({candidates.length})
              </Button>
            )}
            <Button size="sm" variant={picking ? 'warning' : 'secondary'} icon={<Crosshair className="w-3.5 h-3.5" />} onClick={() => startMapPick(picking ? null : { purpose: 'incident_location', incidentId: incident.id })}>
              {picking ? 'Cancel map pick' : 'Set on map'}
            </Button>
          </div>
          {showCandidates && (
            <ul className="rounded-lg border border-border divide-y divide-border bg-bg-inset">
              {candidates.map((c, idx) => (
                <li key={`${c.name}-${idx}`} className="flex items-center gap-2 px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs truncate" title={c.name}>{shortPlace(c.name)}</div>
                    <div className="text-[10px] text-text-dim">
                      {c.kind === 'area' ? 'Area' : c.kind === 'road' ? 'Road' : 'Place'} · match {Math.round(c.score * 100)}%
                      {!c.in_scope && ' · outside Mumbai'}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => {
                    setName(shortPlace(c.name));
                    setPending({ lat: c.lat, lng: c.lng, name: c.name, label: c.name, action: { action: 'choose_candidate', candidate_index: idx } });
                  }}>Use</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Item({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt className="text-[10px] uppercase tracking-wide text-text-dim">{label}</dt>
      <dd className="text-text-muted break-words">{children}</dd>
    </div>
  );
}

/** Geocoder names are full postal addresses; the first few parts identify the place. */
function shortPlace(name: string) {
  return name.split(',').map((p) => p.trim()).filter((p) => !/^(Mumbai|Maharashtra|India|\d{6}|.*Ward|Mumbai Zone \d+|Mumbai Suburban District)$/i.test(p)).slice(0, 3).join(', ');
}
