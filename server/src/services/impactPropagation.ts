interface IncidentLike {
  id: string;
  type: string;
  status: string;
  location_lat: number | null;
  location_lng: number | null;
  affected_radius_m: number;
  priority: string;
  priority_score: number;
  title: string | null;
}

interface ResourceLike {
  id: string;
  type: string;
  name: string;
  location_lat: number | null;
  location_lng: number | null;
  status: string;
  assigned_incident_id: string | null;
}

interface ImpactAssessment {
  type: 'resource_compromised' | 'incident_overlap' | 'cascade_risk';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  affected_entity_id: string;
  affected_entity_type: 'resource' | 'incident';
  distance_m: number;
}

function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Type-specific impact radius multipliers. */
const RADIUS_MULTIPLIERS: Record<string, number> = {
  gas_leak: 3.0,   // gas can spread far
  flood: 2.5,      // floodwater spreads
  fire: 2.0,       // fire can spread
  building_collapse: 1.5,
  road_accident: 1.0,
};

/**
 * When a new incident arrives, check how it impacts nearby resources and other incidents.
 */
export function propagateImpact(
  newIncident: IncidentLike,
  existingIncidents: IncidentLike[],
  resources: ResourceLike[],
): ImpactAssessment[] {
  const assessments: ImpactAssessment[] = [];

  if (newIncident.location_lat == null || newIncident.location_lng == null) {
    return assessments; // can't assess without location
  }

  const multiplier = RADIUS_MULTIPLIERS[newIncident.type] ?? 1.0;
  const impactRadius = newIncident.affected_radius_m * multiplier;

  // Check resources within impact radius
  for (const resource of resources) {
    if (resource.location_lat == null || resource.location_lng == null) continue;

    const distance = haversineDistance(
      newIncident.location_lat, newIncident.location_lng,
      resource.location_lat, resource.location_lng,
    );

    if (distance <= impactRadius) {
      let severity: ImpactAssessment['severity'] = 'low';
      if (distance < impactRadius * 0.3) severity = 'critical';
      else if (distance < impactRadius * 0.6) severity = 'high';
      else if (distance < impactRadius * 0.8) severity = 'medium';

      const isAssigned = resource.status !== 'available';
      const assignedNote = isAssigned
        ? ` (currently ${resource.status}, assigned to incident ${resource.assigned_incident_id})`
        : '';

      assessments.push({
        type: 'resource_compromised',
        severity,
        message: `${resource.name} (${resource.type}) is ${Math.round(distance)}m from ${newIncident.type} incident and may be compromised${assignedNote}`,
        affected_entity_id: resource.id,
        affected_entity_type: 'resource',
        distance_m: Math.round(distance),
      });
    }
  }

  // Check overlap with existing active incidents
  for (const existing of existingIncidents) {
    if (existing.id === newIncident.id) continue;
    if (existing.status === 'resolved' || existing.status === 'closed') continue;
    if (existing.location_lat == null || existing.location_lng == null) continue;

    const distance = haversineDistance(
      newIncident.location_lat, newIncident.location_lng,
      existing.location_lat, existing.location_lng,
    );

    const combinedRadius = impactRadius + existing.affected_radius_m;

    if (distance <= combinedRadius) {
      // Overlapping incidents
      const isCascade = newIncident.type !== existing.type;

      assessments.push({
        type: isCascade ? 'cascade_risk' : 'incident_overlap',
        severity: distance < combinedRadius * 0.3 ? 'critical' : distance < combinedRadius * 0.6 ? 'high' : 'medium',
        message: isCascade
          ? `${newIncident.type} at ${Math.round(distance)}m from existing ${existing.type} ("${existing.title ?? existing.id}") creates cascade risk`
          : `Overlapping ${newIncident.type} incidents within ${Math.round(distance)}m — may be related to "${existing.title ?? existing.id}"`,
        affected_entity_id: existing.id,
        affected_entity_type: 'incident',
        distance_m: Math.round(distance),
      });
    }
  }

  return assessments.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}
