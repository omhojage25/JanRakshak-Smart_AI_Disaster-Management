export type IncidentType = 'fire' | 'flood' | 'building_collapse' | 'gas_leak' | 'road_accident';
export type IncidentStatus = 'triage' | 'dispatched' | 'on_scene' | 'contained' | 'resolved' | 'closed';
export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type ResourceType = 'ambulance' | 'fire_truck' | 'police' | 'hospital' | 'shelter' | 'road_crew';
export type ResourceStatus = 'available' | 'dispatched' | 'en_route' | 'on_scene' | 'unavailable';
export type AssignmentStatus = 'recommended' | 'dispatched' | 'en_route' | 'arrived' | 'completed' | 'rejected';
export type Role = 'admin' | 'coordinator' | 'field_reporter';
export type NotificationType = 'critical' | 'warning' | 'info' | 'success';

export const ACTIVE_STATUSES: IncidentStatus[] = ['triage', 'dispatched', 'on_scene', 'contained'];

export interface User {
  id: string;
  username: string;
  full_name: string;
  role: Role;
  resource_id: string | null;
}

export type LocationSource = 'geocoded' | 'ai_estimate' | 'reporter_gps' | 'landmark' | 'unverified';

export interface Incident {
  id: string;
  type: IncidentType;
  status: IncidentStatus;
  priority: Priority;
  priority_score: number;
  title: string;
  description: string | null;
  raw_message: string | null;
  language: string | null;
  location_lat: number | null;
  location_lng: number | null;
  location_name: string | null;
  location_source?: LocationSource | null;
  people_affected: number;
  injuries: number;
  has_children: boolean;
  has_elderly: boolean;
  has_disabled: boolean;
  urgency_indicators: string[];
  confidence: number;
  corroborating_reports: number;
  affected_radius_m: number;
  escalation_deadline: string | null;
  parent_incident_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  /** XGBoost risk-classification POC output; null for incidents created before the model existed. */
  risk_assessment?: RiskAssessment | null;
  /** How the location was resolved (server/src/services/locate.ts). Null for incidents created before provenance existed. */
  location_meta?: LocationMeta | null;
  /** Set when the incident may duplicate another active incident and a coordinator should decide. */
  dedup_review?: DedupReview | null;
  last_report_at?: string | null;
}

export type LocationPrecision = 'verified' | 'exact' | 'approximate' | 'area' | 'ai_estimate' | 'unverified';

export interface LocationCandidate {
  name: string;
  lat: number;
  lng: number;
  kind: 'point' | 'road' | 'area';
  score: number;
  in_scope: boolean;
  reason?: string;
}

/** Mirrors LocationMeta in server/src/services/locate.ts (fields the UI reads). */
export interface LocationMeta {
  precision: LocationPrecision;
  confidence: number;
  accuracy_m: number;
  source: 'geocoder' | 'reporter_gps' | 'gazetteer' | 'ai_estimate' | 'city_centre' | 'coordinator';
  original_text: string | null;
  matched_query: string | null;
  ambiguous: boolean;
  candidates: LocationCandidate[];
  reporter_gps: { lat: number; lng: number; accuracy_m: number | null } | null;
  gps_consistency: 'consistent' | 'conflict' | 'used' | 'not_available';
  needs_verification: boolean;
  notes: string[];
  verified?: { by: string; at: string; action: string };
}

export interface DedupReviewCandidate {
  incident_id: string;
  score: number;
  reasons: string[];
}

export interface DedupReview {
  status: 'pending' | 'dismissed' | 'merged';
  created_at: string;
  reason?: string;
  candidates: DedupReviewCandidate[];
  target_incident_id?: string;
}

/** One unit requirement for an incident (server/src/services/allocation/demand.ts). */
export interface DemandSlot {
  id: string;
  incident_id: string;
  resource_type: ResourceType;
  index: number;
  required_caps: string[];
  preferred_caps: string[];
  capacity_need: number;
  essential: boolean;
  importance: number;
  purpose: string;
}

export interface IncidentDemand {
  incident_id: string;
  slots: DemandSlot[];
  /** People needing shelter; -1 = evacuation evidenced but number unknown. */
  shelter_need: number;
}

export type ProposalKind = 'new' | 'move' | 'replacement' | 'backfill';

/** resource_assignments.allocation for optimizer-created rows (server/src/services/allocation/allocationRun.ts). */
export interface AllocationMeta {
  run_id: string;
  trigger: string;
  kind: ProposalKind;
  slot: DemandSlot;
  incident_risk: { priority: Priority; priority_score: number };
  utility: {
    risk_weight: number; slot_importance: number; eta_min: number; eta_value: number;
    capability_fit: number; capacity_fit: number; fit: number; scarcity: number; reassignment_cost: number; net: number;
  };
  eta: { minutes: number; distance_m: number | null; source: string | null; route_via: string; gps_fresh: boolean };
  replaces_assignment_id: string | null;
  move_from_incident_id: string | null;
  backfill_for_assignment_id: string | null;
  destination: { type: 'hospital'; id: string; name: string; eta_min: number | null; free_beds: number } | null;
  destination_warning: string | null;
  alternatives: { resource_id: string; name: string; eta_min?: number; reason?: string }[];
  degraded: boolean;
  created_at: string;
}

export interface RecommendResult {
  incident_id: string;
  run_id: string;
  degraded: boolean;
  recommendations: { assignment_id: string | null; resource_id: string; resource_name: string; kind: ProposalKind; eta_minutes: number }[];
  slots: { slot: string; status: 'kept' | 'proposed' | 'unmet'; resource_id: string | null; reason: string | null }[];
}

export type RiskClass = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Mirrors server/src/services/riskAssessment.ts. */
export type RiskAssessment =
  | {
    status: 'ok';
    model_class: RiskClass;
    model_score: number;
    probabilities: Record<RiskClass, number>;
    evidence: Record<string, number | string>;
    factors: string[];
    evidence_source: 'gemini' | 'keyword' | 'merged';
    reports_combined: number;
    model_version: string;
    assessed_at: string;
  }
  | {
    status: 'unavailable';
    reason: string;
    evidence_source: 'gemini' | 'keyword' | 'merged';
    reports_combined: number;
    assessed_at: string;
  };

export interface ImpactAssessment {
  type: 'resource_compromised' | 'incident_overlap' | 'cascade_risk';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  affected_entity_id: string;
  affected_entity_type: 'resource' | 'incident';
  distance_m: number;
}

export interface IncidentReview {
  id: string;
  summary: string;
  went_well: string | null;
  improvements: string | null;
  reviewer_name: string | null;
  created_at: string;
}

export interface IncidentDetailData extends Incident {
  reports: Report[];
  assignments: ResourceAssignment[];
  review: IncidentReview | null;
  impact: ImpactAssessment[];
  allowed_transitions: IncidentStatus[];
}

export interface Report {
  id: string;
  client_id: string | null;
  incident_id: string | null;
  raw_message: string;
  language: string | null;
  source: string;
  reporter_name: string | null;
  reporter_phone: string | null;
  extracted_data: ExtractionResult | null;
  classifier: string | null;
  confidence: number;
  is_duplicate: boolean;
  reported_at: string;
  created_at: string;
}

export interface ExtractionResult {
  type: IncidentType;
  title: string;
  description: string;
  location_name: string | null;
  location_lat: number | null;
  location_lng: number | null;
  people_affected: number;
  injuries: number;
  has_children: boolean;
  has_elderly: boolean;
  has_disabled: boolean;
  urgency_indicators: string[];
  language: string;
  confidence: number;
  priority: Priority;
  priority_score: number;
  classifier: 'gemini' | 'keyword';
}

export interface Resource {
  id: string;
  type: ResourceType;
  name: string;
  location_lat: number | null;
  location_lng: number | null;
  location_name: string | null;
  location_updated_at: string | null;
  location_accuracy_m: number | null;
  status: ResourceStatus;
  capacity: number;
  current_load: number;
  capabilities: string[];
  assigned_incident_id: string | null;
  eta_minutes: number | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceAssignment {
  id: string;
  incident_id: string;
  resource_id: string;
  status: AssignmentStatus;
  ai_score: number | null;
  ai_reasoning: string | null;
  eta_minutes: number | null;
  coordinator_action: string | null;
  coordinator_notes: string | null;
  created_at: string;
  updated_at: string;
  resource_name?: string;
  resource_type?: ResourceType;
  incident_title?: string;
  incident_type?: IncidentType;
  /** Present on rows proposed by the global optimizer; null for manual or legacy rows. */
  allocation?: AllocationMeta | null;
}

export interface AuditEntry {
  id: string;
  entity_type: string;
  entity_id: string | null;
  incident_id: string | null;
  user_name: string | null;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface BlockedRoad {
  id: string;
  incident_id: string | null;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  road_name: string | null;
  reason: string | null;
  created_at: string;
}

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  incident_id: string | null;
  created_at: string;
  read: boolean;
}

export interface ExhaustionPrediction {
  resource_type: ResourceType;
  total: number;
  available: number;
  dispatched: number;
  utilization_pct: number;
  projected_exhaustion_minutes: number | null;
  risk_level: 'low' | 'moderate' | 'high' | 'critical';
  recommendation: string;
}

export interface RoadRoute {
  coordinates: [number, number][];
  distance_m: number;
  duration_s: number;
  source: 'osrm' | 'straight_line';
}

export interface ManagedUser extends User {
  active: boolean;
  created_at: string;
  last_login_at: string | null;
  resource_name: string | null;
}

/** Public-safe incident view for citizen tracking (server/src/services/publicTracking.ts). */
export type TrackStepKey = 'received' | 'assessed' | 'assigned' | 'en_route' | 'arrived' | 'contained' | 'resolved';

export interface PublicIncidentView {
  id: string;
  type: IncidentType;
  priority: Priority;
  status: IncidentStatus;
  area: string | null;
  location: { lat: number; lng: number } | null;
  created_at: string;
  updated_at: string;
  current_step: TrackStepKey;
  steps: { key: TrackStepKey; label: string; state: 'done' | 'current' | 'pending'; at: string | null }[];
  responders: {
    resource_type: ResourceType;
    status: 'dispatched' | 'en_route' | 'arrived';
    eta_minutes: number | null;
    live_location: { lat: number; lng: number; updated_at: string } | null;
  }[];
  response_changed: boolean;
}
