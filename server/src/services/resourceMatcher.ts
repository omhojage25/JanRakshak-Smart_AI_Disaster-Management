interface Incident {
  id: string;
  type: string;
  location_lat: number | null;
  location_lng: number | null;
  priority: string;
  priority_score: number;
  people_affected: number;
  injuries: number;
}

interface Resource {
  id: string;
  type: string;
  name: string;
  location_lat: number | null;
  location_lng: number | null;
  status: string;
  capacity: number;
  current_load: number;
  capabilities: string[] | null;
  assigned_incident_id: string | null;
}

interface Assignment {
  id: string;
  incident_id: string;
  resource_id: string;
  status: string;
}

interface BlockedRoad {
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
}

interface Recommendation {
  resource_id: string;
  resource_name: string;
  resource_type: string;
  score: number;
  score_breakdown: {
    distance: number;
    capability: number;
    availability: number;
    capacity: number;
  };
  reasoning: string;
  conflict: string | null;
  eta_minutes: number | null;
}

/** Map incident type to useful resource types. */
const CAPABILITY_MAP: Record<string, string[]> = {
  fire: ['fire_truck', 'ambulance', 'police'],
  flood: ['police', 'shelter', 'ambulance'],
  building_collapse: ['fire_truck', 'ambulance', 'police'],
  gas_leak: ['fire_truck', 'police', 'ambulance'],
  road_accident: ['ambulance', 'police', 'road_crew'],
};

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

function isNearBlockedRoad(
  lat: number, lng: number,
  blockedRoads: BlockedRoad[],
  thresholdM: number = 200,
): boolean {
  for (const road of blockedRoads) {
    const distToStart = haversineDistance(lat, lng, road.start_lat, road.start_lng);
    const distToEnd = haversineDistance(lat, lng, road.end_lat, road.end_lng);
    if (distToStart < thresholdM || distToEnd < thresholdM) return true;
  }
  return false;
}

/**
 * Score and rank resources for an incident.
 * Returns top 3 recommendations with score breakdown and reasoning.
 */
export function recommendResources(
  incident: Incident,
  allResources: Resource[],
  existingAssignments: Assignment[],
  blockedRoads: BlockedRoad[] = [],
): Recommendation[] {
  const neededTypes = CAPABILITY_MAP[incident.type] ?? ['ambulance', 'police'];
  const recommendations: Recommendation[] = [];

  for (const resource of allResources) {
    const reasons: string[] = [];
    let conflict: string | null = null;

    // Distance score (40% weight) -- lower distance = higher score
    let distanceScore = 0.5; // default if no coords
    let distanceM: number | null = null;

    if (
      incident.location_lat != null && incident.location_lng != null &&
      resource.location_lat != null && resource.location_lng != null
    ) {
      distanceM = haversineDistance(
        incident.location_lat, incident.location_lng,
        resource.location_lat, resource.location_lng,
      );

      // Score: 1.0 at 0m, 0.0 at 20km+
      distanceScore = Math.max(0, 1 - distanceM / 20000);
      reasons.push(`${(distanceM / 1000).toFixed(1)}km away`);

      // Blocked road penalty
      if (isNearBlockedRoad(resource.location_lat, resource.location_lng, blockedRoads)) {
        distanceScore *= 0.5;
        reasons.push('route may pass blocked road');
      }
    } else {
      reasons.push('distance unknown (no coordinates)');
    }

    // Capability match score (25% weight)
    let capabilityScore = 0;
    if (neededTypes.includes(resource.type)) {
      const rank = neededTypes.indexOf(resource.type);
      capabilityScore = 1 - rank * 0.2; // primary type gets 1.0, secondary 0.8, etc.
      reasons.push(`${resource.type} matches ${incident.type} response`);
    } else {
      reasons.push(`${resource.type} not ideal for ${incident.type}`);
    }

    // Check resource-specific capabilities
    const caps = Array.isArray(resource.capabilities) ? resource.capabilities : [];
    if (caps.includes(incident.type)) {
      capabilityScore = Math.min(1, capabilityScore + 0.2);
      reasons.push('has specialized capability');
    }

    // Availability score (20% weight)
    let availabilityScore = 0;
    if (resource.status === 'available') {
      availabilityScore = 1.0;
    } else if (resource.status === 'en_route' || resource.status === 'dispatched') {
      availabilityScore = 0.2;
      conflict = `Currently ${resource.status} to incident ${resource.assigned_incident_id}`;
    } else if (resource.status === 'on_scene') {
      availabilityScore = 0.1;
      conflict = `On scene at incident ${resource.assigned_incident_id}`;
    } else {
      availabilityScore = 0;
      reasons.push('unavailable');
    }

    // Check for existing assignments to this incident
    const alreadyAssigned = existingAssignments.find(
      a => a.resource_id === resource.id && a.incident_id === incident.id &&
        !['completed', 'rejected'].includes(a.status),
    );
    if (alreadyAssigned) {
      conflict = 'Already assigned to this incident';
      availabilityScore = 0;
    }

    // Capacity score (15% weight)
    const remainingCapacity = resource.capacity - resource.current_load;
    const capacityScore = resource.capacity > 0
      ? Math.max(0, remainingCapacity / resource.capacity)
      : 0;

    if (remainingCapacity <= 0) {
      reasons.push('at full capacity');
    } else {
      reasons.push(`${remainingCapacity}/${resource.capacity} capacity available`);
    }

    // Weighted total
    const totalScore =
      distanceScore * 0.40 +
      capabilityScore * 0.25 +
      availabilityScore * 0.20 +
      capacityScore * 0.15;

    // Estimate ETA
    let etaMinutes: number | null = null;
    if (distanceM != null) {
      // Assume average speed 25 km/h in Mumbai traffic
      etaMinutes = Math.round((distanceM / 1000) / 25 * 60);
    }

    recommendations.push({
      resource_id: resource.id,
      resource_name: resource.name,
      resource_type: resource.type,
      score: Math.round(totalScore * 100) / 100,
      score_breakdown: {
        distance: Math.round(distanceScore * 100) / 100,
        capability: Math.round(capabilityScore * 100) / 100,
        availability: Math.round(availabilityScore * 100) / 100,
        capacity: Math.round(capacityScore * 100) / 100,
      },
      reasoning: reasons.join('; '),
      conflict,
      eta_minutes: etaMinutes,
    });
  }

  return recommendations
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
