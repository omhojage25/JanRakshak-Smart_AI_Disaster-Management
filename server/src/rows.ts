import type { Queryable, Row } from './db.js';
import { broadcast } from './realtime.js';

export const ASSIGNMENT_SELECT = `
  SELECT ra.*, r.name AS resource_name, r.type AS resource_type,
         i.title AS incident_title, i.type AS incident_type
  FROM resource_assignments ra
  LEFT JOIN resources r ON ra.resource_id = r.id
  LEFT JOIN incidents i ON ra.incident_id = i.id
`;

export async function getIncident(q: Queryable, id: string) {
  return q.one('SELECT * FROM incidents WHERE id = $1', [id]);
}

export async function getResource(q: Queryable, id: string) {
  return q.one('SELECT * FROM resources WHERE id = $1', [id]);
}

export async function getAssignment(q: Queryable, id: string) {
  return q.one(`${ASSIGNMENT_SELECT} WHERE ra.id = $1`, [id]);
}

/** Records which rows changed during a request so they can be broadcast after the transaction commits. */
export class ChangeSet {
  incidents = new Set<string>();
  resources = new Set<string>();
  assignments = new Set<string>();
  deletedAssignments = new Set<string>();

  async publish(q: Queryable) {
    const publishAll = async (ids: Set<string>, load: (id: string) => Promise<Row | undefined>, entity: 'incident' | 'resource' | 'assignment') => {
      for (const id of ids) {
        const row = await load(id);
        if (row) broadcast(entity, 'upsert', row);
      }
    };
    await publishAll(this.incidents, (id) => getIncident(q, id), 'incident');
    await publishAll(this.resources, (id) => getResource(q, id), 'resource');
    await publishAll(this.assignments, (id) => getAssignment(q, id), 'assignment');
    for (const id of this.deletedAssignments) broadcast('assignment', 'delete', { id });
  }
}
