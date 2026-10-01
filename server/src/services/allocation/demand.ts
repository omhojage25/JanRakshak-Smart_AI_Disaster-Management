/**
 * Incident resource requirements ("demand slots").
 *
 * One slot = one required mobile unit for one incident. The base requirements come from the
 * policy table below (incident type × operational priority); ML evidence then adds or tightens
 * slots (rescue capability, ambulance seats for casualties, evacuation support).
 *
 * The table values are DEMO/POLICY ASSUMPTIONS for the prototype, not validated standards.
 * This is the single demand definition: the exhaustion predictor reads it too.
 */
import type { IncidentType, Priority } from '../../constants.js';
import { incidentEvidence, type RiskEvidence } from '../riskAssessment.js';
import { ALLOCATION_CONFIG } from './config.js';

/** Units that can be dispatched. Hospitals and shelters are destinations, never dispatched. */
export const MOBILE_RESOURCE_TYPES = ['ambulance', 'fire_truck', 'police', 'road_crew'] as const;
export type MobileType = (typeof MOBILE_RESOURCE_TYPES)[number];
export const FACILITY_RESOURCE_TYPES = ['hospital', 'shelter'] as const;

interface SlotSpec {
  type: MobileType;
  count: number;
  /** Capabilities every unit in this spec must have (hard constraint). */
  required?: string[];
  /** Capabilities that improve fit (soft). */
  preferred?: string[];
  /** Essential types count towards "unmet essential demand"; others are supporting units. */
  essential?: boolean;
}

const s = (type: MobileType, count: number, extra: Omit<SlotSpec, 'type' | 'count'> = {}): SlotSpec => ({ type, count, essential: true, ...extra });
const support = (type: MobileType, count: number, extra: Omit<SlotSpec, 'type' | 'count'> = {}): SlotSpec => ({ type, count, essential: false, ...extra });

/** Base requirements: app incident type × operational priority. Policy/demo values. */
export const DEMAND_POLICY: Record<IncidentType, Record<Priority, SlotSpec[]>> = {
  fire: {
    low: [s('fire_truck', 1, { required: ['fire_suppression'] })],
    medium: [s('fire_truck', 1, { required: ['fire_suppression'] }), support('ambulance', 1)],
    high: [s('fire_truck', 2, { required: ['fire_suppression'] }), s('ambulance', 1), support('police', 1)],
    critical: [s('fire_truck', 3, { required: ['fire_suppression'], preferred: ['ladder'] }), s('ambulance', 2), support('police', 1)],
  },
  flood: {
    low: [s('police', 1)],
    medium: [s('police', 1, { preferred: ['evacuation'] }), support('ambulance', 1)],
    high: [s('police', 2, { preferred: ['evacuation'] }), s('ambulance', 1), support('road_crew', 1, { preferred: ['pumping'] })],
    critical: [s('police', 2, { preferred: ['evacuation'] }), s('ambulance', 2), s('fire_truck', 1, { required: ['rescue'] }), support('road_crew', 1, { preferred: ['pumping'] })],
  },
  building_collapse: {
    low: [s('fire_truck', 1, { required: ['rescue'] })],
    medium: [s('fire_truck', 1, { required: ['rescue'] }), s('ambulance', 1)],
    high: [s('fire_truck', 2, { required: ['rescue'] }), s('ambulance', 1), support('police', 1)],
    critical: [s('fire_truck', 2, { required: ['rescue'] }), s('ambulance', 2), support('police', 1), support('road_crew', 1, { preferred: ['debris_clearing'] })],
  },
  gas_leak: {
    low: [s('fire_truck', 1, { required: ['hazmat'] }), support('police', 1)],
    medium: [s('fire_truck', 1, { required: ['hazmat'] }), s('police', 1, { preferred: ['evacuation'] })],
    high: [s('fire_truck', 1, { required: ['hazmat'] }), s('police', 1, { preferred: ['evacuation'] }), s('ambulance', 1)],
    critical: [s('fire_truck', 2, { required: ['hazmat'] }), s('police', 1, { preferred: ['evacuation'] }), s('ambulance', 1)],
  },
  road_accident: {
    low: [s('police', 1, { preferred: ['traffic_management'] })],
    medium: [s('ambulance', 1), support('police', 1, { preferred: ['traffic_management'] })],
    high: [s('ambulance', 2), s('police', 1, { preferred: ['traffic_management'] }), support('road_crew', 1)],
    critical: [s('ambulance', 2), s('police', 1, { preferred: ['traffic_management'] }), s('fire_truck', 1, { required: ['rescue'] }), support('road_crew', 1)],
  },
};

/** Evidence-driven adjustments. Policy/demo values. */
export const DEMAND_EVIDENCE_POLICY = {
  /** Patient seats assumed per ambulance when sizing ambulance demand. */
  ambulanceSeats: 2,
  /** Never request more than this many ambulances for one incident. */
  maxAmbulances: 4,
  /** Flood with at least this many people affected (or an unknown number) adds an evacuation police unit. */
  evacuationThreshold: 100,
  /** Hospitals able to receive casualties must have one of these capabilities. */
  hospitalRequired: ['emergency', 'trauma'],
  /** Specialty preferred per incident type when choosing a destination hospital. */
  hospitalPreferred: { fire: 'burn_unit' } as Partial<Record<IncidentType, string>>,
};

export interface DemandSlot {
  /** Stable id: incidentId:type#index. */
  id: string;
  incident_id: string;
  resource_type: MobileType;
  index: number;
  required_caps: string[];
  preferred_caps: string[];
  /** Patients to transport (ambulance slots); 0 = no transport capacity needed. */
  capacity_need: number;
  essential: boolean;
  importance: number;
  purpose: string;
}

export interface IncidentDemand {
  incident_id: string;
  slots: DemandSlot[];
  /** People needing shelter; -1 = evacuation evidenced but number unknown; 0 = none. */
  shelter_need: number;
  evidence: RiskEvidence;
}

interface IncidentLike {
  id: string;
  type: string;
  priority: string;
  people_affected?: number;
  injuries?: number;
  has_children?: boolean;
  has_elderly?: boolean;
  has_disabled?: boolean;
  risk_assessment?: unknown;
}

/** Builds the demand slots for one incident. Pure; deterministic. */
export function buildIncidentDemand(incident: IncidentLike): IncidentDemand {
  const type = (incident.type in DEMAND_POLICY ? incident.type : 'road_accident') as IncidentType;
  const priority = (['low', 'medium', 'high', 'critical'].includes(incident.priority) ? incident.priority : 'medium') as Priority;
  const e = incidentEvidence(incident as unknown as Record<string, unknown>);

  // Expand the policy specs into individual unit requirements.
  const units: { type: MobileType; required: Set<string>; preferred: Set<string>; essential: boolean; purpose: string; need: number }[] = [];
  for (const spec of DEMAND_POLICY[type][priority]) {
    for (let k = 0; k < spec.count; k++) {
      units.push({
        type: spec.type, required: new Set(spec.required ?? []), preferred: new Set(spec.preferred ?? []),
        essential: spec.essential !== false, purpose: `${type.replace('_', ' ')} ${priority} policy`, need: 0,
      });
    }
  }
  const firstOf = (t: MobileType) => units.find((u) => u.type === t);

  // Trapped people / search and rescue → a fire truck with rescue capability is essential.
  if (e.trapped !== 0 || e.search_rescue) {
    const ft = firstOf('fire_truck');
    if (ft) { ft.required.add('rescue'); ft.essential = true; ft.purpose = 'rescue (trapped / search-and-rescue evidence)'; }
    else units.push({ type: 'fire_truck', required: new Set(['rescue']), preferred: new Set(), essential: true, purpose: 'rescue (trapped / search-and-rescue evidence)', need: 0 });
  }
  // Fire evidence on a non-fire incident → fire suppression.
  if (e.fire && type !== 'fire' && !units.some((u) => u.type === 'fire_truck' && u.required.has('fire_suppression'))) {
    units.push({ type: 'fire_truck', required: new Set(['fire_suppression']), preferred: new Set(), essential: true, purpose: 'fire evidence', need: 0 });
  }

  // Casualties → ambulances sized by patient seats; each carries its share of patients.
  const { ambulanceSeats, maxAmbulances, evacuationThreshold } = DEMAND_EVIDENCE_POLICY;
  if (e.injured !== 0) {
    const patients = e.injured > 0 ? e.injured : 1; // unknown count: at least one patient
    const needed = Math.min(maxAmbulances, Math.ceil(patients / ambulanceSeats));
    let ambulances = units.filter((u) => u.type === 'ambulance');
    for (let k = ambulances.length; k < needed; k++) {
      units.push({ type: 'ambulance', required: new Set(), preferred: new Set(), essential: true, purpose: 'casualty transport', need: 0 });
    }
    ambulances = units.filter((u) => u.type === 'ambulance');
    let remaining = Math.min(patients, ambulances.length * ambulanceSeats);
    for (const a of ambulances) {
      a.need = Math.min(ambulanceSeats, remaining);
      remaining -= a.need;
      if (a.need > 0) { a.essential = true; a.purpose = `casualty transport (${a.need} patient${a.need > 1 ? 's' : ''})`; }
    }
    if (e.injured > ambulanceSeats) ambulances[0]?.preferred.add('advanced_life_support');
  }

  // Flood with a large or unknown affected population → evacuation support + shelter capacity.
  let shelterNeed = 0;
  const bigFlood = (e.flood || type === 'flood') && (e.people_affected === -1 || e.people_affected >= evacuationThreshold);
  if (bigFlood) {
    units.push({ type: 'police', required: new Set(['evacuation']), preferred: new Set(), essential: false, purpose: 'evacuation support', need: 0 });
    shelterNeed = e.people_affected > 0 ? e.people_affected : -1;
  }

  // Number the units per type and assign importance: first essential unit 1.0, later units decay.
  const counters: Partial<Record<MobileType, number>> = {};
  const { additionalUnitFactor, supportTypeFactor } = ALLOCATION_CONFIG;
  const slots: DemandSlot[] = units
    .sort((a, b) => Number(b.essential) - Number(a.essential))
    .map((u) => {
      const index = (counters[u.type] = (counters[u.type] ?? 0) + 1);
      const importance = (u.essential ? 1 : supportTypeFactor) * additionalUnitFactor ** (index - 1);
      return {
        id: `${incident.id}:${u.type}#${index}`,
        incident_id: incident.id,
        resource_type: u.type,
        index,
        required_caps: [...u.required].sort(),
        preferred_caps: [...u.preferred].sort(),
        capacity_need: u.need,
        essential: u.essential && index === 1,
        importance: Math.round(importance * 1000) / 1000,
        purpose: u.purpose,
      };
    });

  return { incident_id: incident.id, slots, shelter_need: shelterNeed, evidence: e };
}

/** Resource types an incident type can consume, from the same policy table (used by the exhaustion predictor). */
export function resourceTypesForIncidentType(type: string): string[] {
  const table = DEMAND_POLICY[type as IncidentType];
  if (!table) return ['ambulance', 'police'];
  return [...new Set(Object.values(table).flat().map((spec) => spec.type))];
}
