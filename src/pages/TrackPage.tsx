import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  AlertTriangle, Check, CheckCircle2, Clock, Copy, Loader2, MapPin, Radio, ShieldAlert, Truck,
} from 'lucide-react';
import { useIncidentTracking } from '../lib/publicRealtime';
import { PublicShell } from '../components/layout/PublicShell';
import { Callout } from '../components/ui/primitives';
import { cx } from '../utils/cx';
import { INCIDENT_TYPE_CONFIG, RESOURCE_TYPE_CONFIG, formatClock, publicPlaceName, formatDistance, formatTimeAgo, haversineDistance, shortId } from '../utils/helpers';
import type { IncidentType, PublicIncidentView } from '../types';

/** One plain sentence per step, so the citizen always knows what is happening right now. */
const CURRENT_MESSAGE: Record<PublicIncidentView['current_step'], string> = {
  received: 'Your report has been received.',
  assessed: 'Your report has been assessed. A coordinator is choosing the right response team.',
  assigned: 'A response team has been assigned and is getting ready.',
  en_route: 'Help is on the way.',
  arrived: 'Responders have arrived at the scene.',
  contained: 'The situation is under control. Responders are finishing up.',
  resolved: 'This emergency has been resolved.',
};

const RESPONDER_STATUS: Record<PublicIncidentView['responders'][number]['status'], string> = {
  dispatched: 'Assigned',
  en_route: 'On the way',
  arrived: 'At the scene',
};

/** General public-safety advice while waiting; the same for every report of a type. */
const WHILE_YOU_WAIT: Record<IncidentType, string[]> = {
  fire: ['Move away from the smoke and stay low if you are indoors.', 'Do not use lifts. Leave by the stairs if it is safe.', 'Keep the road clear for fire engines.'],
  flood: ['Move to higher ground and avoid walking or driving through moving water.', 'Stay away from electric poles and fallen wires.', 'Keep your phone charged for updates.'],
  building_collapse: ['Stay away from the damaged structure and anything leaning or cracked.', 'Do not try to lift heavy debris yourself.', 'Tell responders where people were last seen.'],
  gas_leak: ['Do not light flames or switch electrical items on or off.', 'Move upwind and away from the smell.', 'Keep others from entering the area.'],
  road_accident: ['Do not move injured people unless they are in immediate danger.', 'Switch on hazard lights and keep traffic away.', 'Keep the lane clear for the ambulance.'],
};

function divIcon(html: string, size: number) {
  return L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function FitToResponders({ incident, unit, liveCount }: { incident: [number, number]; unit: [number, number] | null; liveCount: number }) {
  const map = useMap();
  useEffect(() => {
    if (unit) map.fitBounds(L.latLngBounds([incident, unit]).pad(0.3), { maxZoom: 16 });
    else map.setView(incident, 15);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on liveCount only
  }, [map, liveCount]);
  return null;
}

function TrackingMap({ view }: { view: PublicIncidentView }) {
  const loc = view.location!;
  const moving = view.responders.filter((r) => r.live_location);
  const incidentIcon = useMemo(
    () => divIcon(`<div class="jr-incident-marker" style="width:34px;height:34px;border-color:#ef4444;background:rgba(239,68,68,0.25);font-size:17px">${INCIDENT_TYPE_CONFIG[view.type].icon}</div>`, 34),
    [view.type],
  );
  // Refit only when a live unit appears or disappears, not on every GPS ping, so the view doesn't jump around.
  const firstLive = moving[0]?.live_location;

  return (
    <div className="rounded-xl overflow-hidden border border-border">
      <div className="h-56 sm:h-64">
        <MapContainer center={[loc.lat, loc.lng]} zoom={15} scrollWheelZoom={false} className="h-full w-full">
          <FitToResponders incident={[loc.lat, loc.lng]} unit={firstLive ? [firstLive.lat, firstLive.lng] : null} liveCount={moving.length} />
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
          <Marker position={[loc.lat, loc.lng]} icon={incidentIcon} />
          {moving.map((r, i) => {
            const cfg = RESOURCE_TYPE_CONFIG[r.resource_type];
            return (
              <Marker
                key={i}
                position={[r.live_location!.lat, r.live_location!.lng]}
                icon={divIcon(`<div class="jr-resource-marker jr-live" style="border-color:#38bdf8">${cfg.icon}<span class="jr-live-badge">LIVE</span></div>`, 24)}
              />
            );
          })}
        </MapContainer>
      </div>
      <div className="px-3 py-2 bg-bg-card text-[11px] text-text-dim">
        {moving.length ? 'Showing the live position of the team on the way.' : 'The team’s live position appears here while it is on the way and sharing GPS.'}
      </div>
    </div>
  );
}

function Timeline({ view }: { view: PublicIncidentView }) {
  return (
    <ol aria-label="Response progress">
      {view.steps.map((s, i) => {
        const last = i === view.steps.length - 1;
        return (
          <li key={s.key} className="flex gap-3" aria-current={s.state === 'current' ? 'step' : undefined}>
            <div className="flex flex-col items-center">
              <span className={cx('w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 border-2',
                s.state === 'done' ? 'bg-success border-success text-white'
                  : s.state === 'current' ? 'border-accent bg-accent/15 text-accent' : 'border-border text-text-dim')}>
                {s.state === 'done' ? <Check className="w-4 h-4" /> : s.state === 'current' ? <span className="w-2.5 h-2.5 rounded-full bg-accent" /> : null}
              </span>
              {!last && <span className={cx('w-0.5 flex-1 min-h-5', s.state === 'done' ? 'bg-success' : 'bg-border')} />}
            </div>
            <div className="pb-4 flex-1 flex items-baseline justify-between gap-2 pt-1">
              <span className={cx('text-sm', s.state === 'pending' ? 'text-text-dim' : s.state === 'current' ? 'font-semibold text-text' : 'text-text-muted')}>
                {s.label}
                <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'current' ? ' (current step)' : ' (not yet)'}</span>
              </span>
              {s.at && s.state !== 'pending' && <span className="text-xs text-text-dim tabular-nums">{formatClock(s.at)}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function HelpOnTheWay({ view }: { view: PublicIncidentView }) {
  if (view.response_changed) {
    return (
      <Callout tone="warning" title="Your response team was changed">
        The team first assigned was redirected to a more urgent emergency. A coordinator is assigning another team.
      </Callout>
    );
  }
  if (view.responders.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-bg-card p-4 space-y-3" aria-labelledby="help">
      <h2 id="help" className="text-sm font-semibold flex items-center gap-2"><Truck className="w-4 h-4 text-accent" /> Help on the way</h2>
      <ul className="space-y-2">
        {view.responders.map((r, i) => {
          const cfg = RESOURCE_TYPE_CONFIG[r.resource_type];
          const distM = r.live_location && view.location
            ? haversineDistance(r.live_location.lat, r.live_location.lng, view.location.lat, view.location.lng) * 1000
            : null;
          return (
            <li key={i} className="flex items-center gap-3 p-3 rounded-lg bg-bg-inset border border-border">
              <span className="text-2xl" aria-hidden>{cfg.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">{cfg.label}</div>
                <div className="text-xs text-text-muted flex flex-wrap gap-x-2">
                  <span className={r.status === 'arrived' ? 'text-success' : ''}>{RESPONDER_STATUS[r.status]}</span>
                  {distM != null && <span>{formatDistance(distM)} away</span>}
                  {r.live_location && <span className="text-success inline-flex items-center gap-0.5"><Radio className="w-3 h-3" /> live</span>}
                </div>
              </div>
              {r.eta_minutes != null && r.status !== 'arrived' && (
                <div className="text-right">
                  <div className="text-xl font-semibold tabular-nums leading-none">~{r.eta_minutes}<span className="text-xs font-normal text-text-dim"> min</span></div>
                  <div className="text-[10px] text-text-dim mt-1">estimated arrival</div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-text-dim">Arrival times are estimated when the team is sent and may change with traffic.</p>
    </section>
  );
}

export function TrackPage() {
  const { incidentId = '' } = useParams();
  const { state, live } = useIncidentTracking(incidentId);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked; the address bar still has the link
    }
  };

  return (
    <PublicShell
      context={(
        <span className={cx('inline-flex items-center gap-1.5 normal-case tracking-normal text-[11px] font-medium', live ? 'text-success' : 'text-text-dim')}>
          <span className={cx('w-1.5 h-1.5 rounded-full', live ? 'bg-success' : 'bg-text-dim')} /> {live ? 'Live updates' : 'Reconnecting…'}
        </span>
      )}
      footer={<>This page updates by itself. If a life is in danger, also call <b className="text-text-muted">112</b>.</>}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Track your report</h1>
          <p className="text-xs text-text-dim mt-0.5">Tracking ID <span className="font-mono font-semibold text-text-muted tracking-wider">{shortId(incidentId)}</span></p>
        </div>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs text-text-muted hover:text-text cursor-pointer">
          {copied ? <CheckCircle2 className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />} {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>

      {state.kind === 'loading' && <div className="py-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-accent" /></div>}

      {state.kind === 'not_found' && (
        <Callout tone="warning" title="Report not found">
          No report matches this tracking link. Check the link, or <Link to="/public-report" className="underline">send a new report</Link>.
        </Callout>
      )}

      {state.kind === 'error' && <Callout tone="danger" icon={<AlertTriangle className="w-4 h-4" />}>{state.message}</Callout>}

      {state.kind === 'ready' && (() => {
        const v = state.view;
        const type = INCIDENT_TYPE_CONFIG[v.type];
        const resolved = v.current_step === 'resolved';
        return (
          <>
            <div className={cx('rounded-xl border p-4 flex items-start gap-3',
              resolved ? 'bg-success/10 border-success/40' : 'bg-accent/10 border-accent/40')} role="status">
              {resolved ? <CheckCircle2 className="w-6 h-6 text-success flex-shrink-0" /> : <ShieldAlert className="w-6 h-6 text-accent flex-shrink-0" />}
              <div>
                <div className="text-base font-semibold">{CURRENT_MESSAGE[v.current_step]}</div>
                <div className="text-xs text-text-muted mt-0.5">Last update {formatTimeAgo(v.updated_at).toLowerCase()}</div>
              </div>
            </div>

            <section className="rounded-xl border border-border bg-bg-card p-4 flex items-start gap-3" aria-label="Report summary">
              <span className="text-2xl" aria-hidden>{type.icon}</span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="font-semibold">{type.label} reported</div>
                {v.area && <div className="text-sm text-text-muted flex items-center gap-1"><MapPin className="w-3.5 h-3.5 flex-shrink-0" /> {publicPlaceName(v.area)}</div>}
                <div className="text-xs text-text-dim flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Reported {formatTimeAgo(v.created_at).toLowerCase()}</div>
              </div>
            </section>

            <HelpOnTheWay view={v} />

            {v.location && <TrackingMap view={v} />}

            <section className="rounded-xl border border-border bg-bg-card p-4" aria-labelledby="progress">
              <h2 id="progress" className="text-sm font-semibold mb-3">Response progress</h2>
              <Timeline view={v} />
            </section>

            {!resolved && (
              <section className="rounded-xl border border-warning/40 bg-warning/[0.06] p-4" aria-labelledby="wait">
                <h2 id="wait" className="text-sm font-semibold text-yellow-200 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> While you wait</h2>
                <ul className="mt-2 space-y-1.5 text-sm text-text-muted list-disc pl-5">
                  {WHILE_YOU_WAIT[v.type].map((tip) => <li key={tip}>{tip}</li>)}
                </ul>
              </section>
            )}
          </>
        );
      })()}
    </PublicShell>
  );
}
