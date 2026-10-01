export const INCIDENT_TYPES = ['fire', 'flood', 'building_collapse', 'gas_leak', 'road_accident'] as const;
export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export const INCIDENT_STATUSES = ['triage', 'dispatched', 'on_scene', 'contained', 'resolved', 'closed'] as const;
export const ACTIVE_INCIDENT_STATUSES = ['triage', 'dispatched', 'on_scene', 'contained'] as const;
export const RESOURCE_TYPES = ['ambulance', 'fire_truck', 'police', 'hospital', 'shelter', 'road_crew'] as const;
export const RESOURCE_STATUSES = ['available', 'dispatched', 'en_route', 'on_scene', 'unavailable'] as const;
export const ASSIGNMENT_STATUSES = ['recommended', 'dispatched', 'en_route', 'arrived', 'completed', 'rejected'] as const;
export const ACTIVE_ASSIGNMENT_STATUSES = ['dispatched', 'en_route', 'arrived'] as const;
export const ROLES = ['admin', 'coordinator', 'field_reporter'] as const;
export const NOTIFICATION_TYPES = ['critical', 'warning', 'info', 'success'] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export type Role = (typeof ROLES)[number];
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Minutes allowed before an unattended incident is escalated. */
export const ESCALATION_THRESHOLD_MIN: Record<IncidentType, number> = {
  building_collapse: 20,
  gas_leak: 30,
  road_accident: 40,
  fire: 45,
  flood: 60,
};

export const DEFAULT_RADIUS_M: Record<IncidentType, number> = {
  fire: 200,
  flood: 500,
  building_collapse: 150,
  gas_leak: 300,
  road_accident: 100,
};

/** Renders a constant list as a SQL literal list. Only for compile-time constants, never user input. */
export function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}
