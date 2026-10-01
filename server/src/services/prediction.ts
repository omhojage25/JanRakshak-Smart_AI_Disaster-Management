import { resourceTypesForIncidentType } from './allocation/demand.js';

interface ResourceForPrediction {
  id: string;
  type: string;
  name: string;
  status: string;
  capacity: number;
  current_load: number;
}

interface IncidentForPrediction {
  id: string;
  type: string;
  status: string;
  created_at: string | Date;
}

export interface ExhaustionPrediction {
  resource_type: string;
  total: number;
  available: number;
  dispatched: number;
  utilization_pct: number;
  projected_exhaustion_minutes: number | null;
  risk_level: 'low' | 'moderate' | 'high' | 'critical';
  recommendation: string;
}

/**
 * Predict when resource types will be exhausted based on current usage and incident rate.
 */
export function predictExhaustion(
  resources: ResourceForPrediction[],
  incidents: IncidentForPrediction[],
  assignmentRatePerHour?: number,
): ExhaustionPrediction[] {
  // Group resources by type
  const byType = new Map<string, {
    total: number;
    available: number;
    dispatched: number;
  }>();

  for (const r of resources) {
    const entry = byType.get(r.type) ?? { total: 0, available: 0, dispatched: 0 };
    entry.total++;
    if (r.status === 'available') entry.available++;
    if (['dispatched', 'en_route', 'on_scene'].includes(r.status)) entry.dispatched++;
    byType.set(r.type, entry);
  }

  // Calculate incident arrival rate from recent incidents (last 6 hours)
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  const recentIncidents = incidents.filter(
    i => (i.status !== 'resolved' && i.status !== 'closed') || new Date(i.created_at).getTime() > sixHoursAgo,
  );

  // Count how many incidents of each type need each resource type
  const demandCounts = new Map<string, number>();
  for (const inc of recentIncidents) {
    // Shared demand policy (allocation/demand.ts), so allocation and prediction agree.
    const neededTypes = resourceTypesForIncidentType(inc.type);
    for (const rt of neededTypes) {
      demandCounts.set(rt, (demandCounts.get(rt) ?? 0) + 1);
    }
  }

  // Calculate arrival rate (incidents per hour)
  let incidentsPerHour = assignmentRatePerHour ?? 0;
  if (!assignmentRatePerHour && recentIncidents.length >= 2) {
    const times = recentIncidents
      .map(i => new Date(i.created_at).getTime())
      .sort((a, b) => a - b);
    const spanMs = times[times.length - 1] - times[0];
    if (spanMs > 0) {
      incidentsPerHour = (recentIncidents.length / spanMs) * 3600000;
    }
  }

  const predictions: ExhaustionPrediction[] = [];

  for (const [type, counts] of byType) {
    const utilization = counts.total > 0
      ? ((counts.total - counts.available) / counts.total) * 100
      : 0;

    // Estimate consumption rate for this resource type
    const demandPerIncident = (demandCounts.get(type) ?? 0) / Math.max(recentIncidents.length, 1);
    const consumptionPerHour = incidentsPerHour * demandPerIncident;

    let exhaustionMinutes: number | null = null;
    if (consumptionPerHour > 0 && counts.available > 0) {
      exhaustionMinutes = Math.round((counts.available / consumptionPerHour) * 60);
    } else if (counts.available === 0) {
      exhaustionMinutes = 0; // already exhausted
    }

    let riskLevel: ExhaustionPrediction['risk_level'] = 'low';
    let recommendation = `${type} resources adequate for current demand`;

    if (counts.available === 0) {
      riskLevel = 'critical';
      recommendation = `All ${type} resources exhausted. Request mutual aid from neighboring jurisdictions immediately.`;
    } else if (utilization >= 80 || (exhaustionMinutes != null && exhaustionMinutes < 60)) {
      riskLevel = 'high';
      recommendation = `${type} resources at ${Math.round(utilization)}% utilization. Pre-position backup units and alert neighboring stations.`;
    } else if (utilization >= 60 || (exhaustionMinutes != null && exhaustionMinutes < 180)) {
      riskLevel = 'moderate';
      recommendation = `${type} resources moderately strained. Monitor closely and prepare contingency.`;
    }

    predictions.push({
      resource_type: type,
      total: counts.total,
      available: counts.available,
      dispatched: counts.dispatched,
      utilization_pct: Math.round(utilization),
      projected_exhaustion_minutes: exhaustionMinutes,
      risk_level: riskLevel,
      recommendation,
    });
  }

  return predictions.sort((a, b) => {
    const riskOrder = { critical: 0, high: 1, moderate: 2, low: 3 };
    return riskOrder[a.risk_level] - riskOrder[b.risk_level];
  });
}
