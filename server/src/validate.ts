export class ValidationError extends Error {}

export function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return trimmed || null;
}

export function requiredString(value: unknown, field: string, max: number): string {
  const s = optionalString(value, field, max);
  if (!s) throw new ValidationError(`${field} is required`);
  return s;
}

export function optionalNumber(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return n;
}

export function optionalInt(value: unknown, field: string, min: number, max: number): number | null {
  const n = optionalNumber(value, field, min, max);
  return n === null ? null : Math.round(n);
}

export function optionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function optionalBool(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  throw new ValidationError(`${field} must be true or false`);
}

export function latLng(latValue: unknown, lngValue: unknown, label = 'location'): { lat: number; lng: number } | null {
  const lat = optionalNumber(latValue, `${label} latitude`, -90, 90);
  const lng = optionalNumber(lngValue, `${label} longitude`, -180, 180);
  if (lat === null && lng === null) return null;
  if (lat === null || lng === null) throw new ValidationError(`${label} needs both latitude and longitude`);
  return { lat, lng };
}
