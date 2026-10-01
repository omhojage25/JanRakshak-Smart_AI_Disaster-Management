import { v4 as uuidv4 } from 'uuid';
import type { Queryable } from '../db.js';
import type { AuthUser } from '../auth.js';

export interface AuditEntry {
  entityType: string;
  entityId: string | null;
  action: string;
  details?: Record<string, unknown>;
  incidentId?: string | null;
  user?: AuthUser | null;
}

export async function audit(q: Queryable, entry: AuditEntry) {
  await q.query(
    `INSERT INTO audit_log (id, entity_type, entity_id, incident_id, user_id, user_name, action, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      uuidv4(),
      entry.entityType,
      entry.entityId,
      entry.incidentId ?? null,
      entry.user?.id ?? null,
      entry.user?.full_name ?? 'System',
      entry.action,
      JSON.stringify(entry.details ?? {}),
    ],
  );
}
