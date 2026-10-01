import type {
  Incident, IncidentStatus, IncidentType, LocationPrecision, LocationSource, Priority, ProposalKind, ResourceType, Role,
} from '../types';

export const LOCATION_SOURCE_LABEL: Record<LocationSource, string> = {
  geocoded: 'found on map',
  ai_estimate: 'AI estimate',
  reporter_gps: "reporter's GPS",
  landmark: 'nearest known area',
  unverified: 'not given, verify with reporter',
};

export const STATUS_CONFIG: Record<IncidentStatus, { label: string; color: string; description: string }> = {
  triage: { label: 'Triage', color: '#eab308', description: 'Reported, awaiting dispatch' },
  dispatched: { label: 'Dispatched', color: '#3b82f6', description: 'Resources on the way' },
  on_scene: { label: 'On scene', color: '#a855f7', description: 'Responders at the site' },
  contained: { label: 'Contained', color: '#14b8a6', description: 'Threat under control' },
  resolved: { label: 'Resolved', color: '#22c55e', description: 'Response complete, resources released' },
  closed: { label: 'Closed', color: '#64748b', description: 'Post-incident review filed' },
};

export const WORKFLOW_ORDER: IncidentStatus[] = ['triage', 'dispatched', 'on_scene', 'contained', 'resolved', 'closed'];

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  coordinator: 'Coordinator',
  field_reporter: 'Field unit',
};

export function isLiveLocation(updatedAt: string | null | undefined, withinMs = 2 * 60_000) {
  return !!updatedAt && Date.now() - new Date(updatedAt).getTime() < withinMs;
}

export const PRIORITY_CONFIG: Record<Priority, { label: string; color: string; bg: string; order: number }> = {
  critical: { label: 'Critical', color: '#ef4444', bg: 'rgba(239,68,68,0.15)', order: 0 },
  high: { label: 'High', color: '#f97316', bg: 'rgba(249,115,22,0.15)', order: 1 },
  medium: { label: 'Medium', color: '#eab308', bg: 'rgba(234,179,8,0.15)', order: 2 },
  low: { label: 'Low', color: '#8fb3d9', bg: 'rgba(143,179,217,0.14)', order: 3 },
};

export const INCIDENT_TYPE_CONFIG: Record<IncidentType, { label: string; icon: string; color: string; defaultRadius: number }> = {
  fire: { label: 'Fire', icon: '🔥', color: '#ef4444', defaultRadius: 200 },
  flood: { label: 'Flood', icon: '🌊', color: '#3b82f6', defaultRadius: 500 },
  building_collapse: { label: 'Building Collapse', icon: '🏚️', color: '#a855f7', defaultRadius: 150 },
  gas_leak: { label: 'Gas Leak', icon: '☠️', color: '#f59e0b', defaultRadius: 300 },
  road_accident: { label: 'Road Accident', icon: '🚗', color: '#ec4899', defaultRadius: 100 },
};

export const RESOURCE_TYPE_CONFIG: Record<ResourceType, { label: string; icon: string; color: string }> = {
  ambulance: { label: 'Ambulance', icon: '🚑', color: '#ef4444' },
  fire_truck: { label: 'Fire Truck', icon: '🚒', color: '#f97316' },
  police: { label: 'Police', icon: '🚔', color: '#3b82f6' },
  hospital: { label: 'Hospital', icon: '🏥', color: '#22c55e' },
  shelter: { label: 'Shelter', icon: '🏠', color: '#8b5cf6' },
  road_crew: { label: 'Road Crew', icon: '🚧', color: '#eab308' },
};

export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function formatTimeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function getEscalationTimeLeft(deadline: string | null): { minutes: number; color: string; label: string } | null {
  if (!deadline) return null;
  const now = new Date();
  const dl = new Date(deadline);
  const diffMin = Math.floor((dl.getTime() - now.getTime()) / 60000);
  if (diffMin <= 0) return { minutes: 0, color: '#ef4444', label: 'OVERDUE' };
  if (diffMin <= 10) return { minutes: diffMin, color: '#ef4444', label: `${diffMin}m left` };
  if (diffMin <= 20) return { minutes: diffMin, color: '#f97316', label: `${diffMin}m left` };
  return { minutes: diffMin, color: '#eab308', label: `${diffMin}m left` };
}

export function capacityPercentage(current: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((current / total) * 100);
}

export function capacityColor(pct: number): string {
  if (pct >= 90) return '#ef4444';
  if (pct >= 70) return '#f97316';
  if (pct >= 50) return '#eab308';
  return '#22c55e';
}

/** First 8 characters of a UUID, upper-cased, for display. The full id is still used in links. */
export function shortId(id: string) {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

export function formatClock(at: string) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDistance(m: number | null | undefined) {
  if (m == null) return null;
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export type LocationTone = 'good' | 'fair' | 'warn' | 'bad';

export interface LocationQuality {
  precision: LocationPrecision | null;
  label: string;
  tone: LocationTone;
  /** A coordinator should confirm or correct this location before relying on the pin. */
  needsVerification: boolean;
  /** One short sentence explaining the quality, for tooltips and callouts. */
  explanation: string;
}

const PRECISION_QUALITY: Record<LocationPrecision, Omit<LocationQuality, 'precision' | 'needsVerification'>> = {
  verified: { label: 'Verified location', tone: 'good', explanation: 'Confirmed by a coordinator.' },
  exact: { label: 'Exact location', tone: 'good', explanation: 'Matched to a specific place or accurate GPS.' },
  approximate: { label: 'Approximate location', tone: 'fair', explanation: 'Matched with moderate confidence; the pin may be off by a few hundred metres.' },
  area: { label: 'Area-level location', tone: 'warn', explanation: 'Only the neighbourhood is known; the pin is the centre of the area.' },
  ai_estimate: { label: 'AI-estimated location', tone: 'bad', explanation: 'No place could be matched; the pin is a rough AI guess.' },
  unverified: { label: 'Location needs verification', tone: 'bad', explanation: 'The location could not be confirmed from the report.' },
};

/** Location quality from the backend's provenance record, falling back to the older location_source field. */
export function locationQuality(incident: Pick<Incident, 'location_meta' | 'location_source'>): LocationQuality {
  const meta = incident.location_meta;
  if (meta?.precision) {
    const base = PRECISION_QUALITY[meta.precision];
    const needs = meta.precision !== 'verified' && (meta.needs_verification || meta.ambiguous
      || meta.precision === 'unverified' || meta.precision === 'ai_estimate');
    const explanation = meta.ambiguous
      ? 'Several places match this name; confirm which one is meant.'
      : meta.gps_consistency === 'conflict'
        ? "The reporter's GPS disagrees with the named place."
        : base.explanation;
    return { precision: meta.precision, ...base, needsVerification: needs, explanation };
  }
  switch (incident.location_source) {
    case 'reporter_gps': return { precision: null, label: "Reporter's GPS", tone: 'good', needsVerification: false, explanation: "Taken from the reporter's phone." };
    case 'geocoded': return { precision: null, label: 'Found on map', tone: 'fair', needsVerification: false, explanation: 'Matched by the geocoder.' };
    case 'landmark': return { precision: null, ...PRECISION_QUALITY.area, needsVerification: false };
    case 'ai_estimate': return { precision: null, ...PRECISION_QUALITY.ai_estimate, needsVerification: true };
    case 'unverified': return { precision: null, ...PRECISION_QUALITY.unverified, needsVerification: true };
    default: return { precision: null, label: 'Location source unknown', tone: 'fair', needsVerification: false, explanation: 'Recorded before location provenance was tracked.' };
  }
}

export const LOCATION_TONE_CLASS: Record<LocationTone, string> = {
  good: 'text-success border-success/30 bg-success/10',
  fair: 'text-sky-300 border-sky-400/30 bg-sky-400/10',
  warn: 'text-warning border-warning/30 bg-warning/10',
  bad: 'text-danger border-danger/30 bg-danger/10',
};

export const PROPOSAL_KIND: Record<ProposalKind, { label: string; description: string }> = {
  new: { label: 'New assignment', description: 'An available unit for an open requirement.' },
  move: { label: 'Reallocation', description: 'Moves a unit that is already committed to another incident.' },
  replacement: { label: 'Replacement', description: 'Replaces a current assignment that is no longer feasible.' },
  backfill: { label: 'Backfill', description: 'Covers an incident whose unit is proposed to move elsewhere.' },
};

const ROUTE_VIA: Record<string, string> = {
  table: 'Road network ETA',
  fastest: 'Fastest road route',
  alternative: 'Alternative route (avoids a blocked road)',
  detour: 'Detour (avoids a blocked road)',
};

export function routeViaLabel(via: string | null | undefined) {
  return via ? ROUTE_VIA[via] ?? via : 'Road ETA';
}

export function capabilityLabel(cap: string) {
  return cap.replace(/_/g, ' ');
}

/** Operational queue order: priority, then the nearest escalation deadline, then newest. */
export function compareOperational(a: Incident, b: Incident) {
  const pa = PRIORITY_CONFIG[a.priority]?.order ?? 3;
  const pb = PRIORITY_CONFIG[b.priority]?.order ?? 3;
  if (pa !== pb) return pa - pb;
  if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
  const da = a.escalation_deadline ? new Date(a.escalation_deadline).getTime() : Infinity;
  const db = b.escalation_deadline ? new Date(b.escalation_deadline).getTime() : Infinity;
  if (da !== db) return da - db;
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

/** Demand-slot purposes from the policy table ("gas leak critical policy") read as plain requirements. */
export function slotPurpose(purpose: string) {
  const m = /^(.+) (low|medium|high|critical) policy$/.exec(purpose);
  if (m) return `Standard response for a ${m[2]}-priority ${m[1]}`;
  return purpose.charAt(0).toUpperCase() + purpose.slice(1);
}

/** Location label for citizens: drops internal resolution notes such as "(area: Andheri West)". */
export function publicPlaceName(name: string | null | undefined) {
  return name ? name.replace(/\s*\(area: [^)]*\)/i, '').trim() : null;
}
