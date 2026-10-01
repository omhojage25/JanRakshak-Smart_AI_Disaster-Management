import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { requireRole } from '../auth.js';
import { route } from '../http.js';
import { RESOURCE_STATUSES, RESOURCE_TYPES } from '../constants.js';
import { latLng, optionalEnum, optionalInt, optionalNumber, optionalString, requiredString, ValidationError } from '../validate.js';
import { audit } from '../services/audit.js';
import { broadcast } from '../realtime.js';
import { reoptimize } from '../services/allocation/reoptimize.js';

const router = Router();
const staff = requireRole('admin', 'coordinator');

function parseCapabilities(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length <= 60) || value.length > 30) {
    throw new ValidationError('capabilities must be a list of short text labels');
  }
  return value;
}

router.get('/stats', route('Failed to fetch resource stats', async (_req, res) => {
  const db = getDb();
  const totals = await db.one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'available')::int AS available,
            COUNT(*) FILTER (WHERE status IN ('dispatched', 'en_route', 'on_scene'))::int AS dispatched
     FROM resources`,
  );
  const byType = await db.query(
    `SELECT type, COUNT(*)::int AS count, COUNT(*) FILTER (WHERE status = 'available')::int AS available
     FROM resources GROUP BY type`,
  );
  const byStatus = await db.query('SELECT status, COUNT(*)::int AS count FROM resources GROUP BY status');
  res.json({ ...totals, by_type: byType, by_status: byStatus });
}));

router.get('/', route('Failed to fetch resources', async (req, res) => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (req.query.type) {
    params.push(optionalEnum(req.query.type, 'type', RESOURCE_TYPES));
    conditions.push(`type = $${params.length}`);
  }
  if (req.query.status) {
    params.push(optionalEnum(req.query.status, 'status', RESOURCE_STATUSES));
    conditions.push(`status = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  res.json(await getDb().query(`SELECT * FROM resources ${where} ORDER BY status, name`, params));
}));

router.get('/:id', route('Failed to fetch resource', async (req, res) => {
  const db = getDb();
  const resource = await db.one('SELECT * FROM resources WHERE id = $1', [req.params.id]);
  if (!resource) {
    res.status(404).json({ error: 'Resource not found' });
    return;
  }
  const assignments = await db.query(
    `SELECT ra.*, i.title AS incident_title, i.type AS incident_type, i.location_lat AS incident_lat,
            i.location_lng AS incident_lng, i.location_name AS incident_location
     FROM resource_assignments ra LEFT JOIN incidents i ON ra.incident_id = i.id
     WHERE ra.resource_id = $1 ORDER BY ra.created_at DESC LIMIT 50`,
    [req.params.id],
  );
  res.json({ ...resource, assignments });
}));

router.post('/', staff, route('Failed to create resource', async (req, res) => {
  const type = optionalEnum(req.body.type, 'type', RESOURCE_TYPES);
  if (!type) throw new ValidationError('type is required');
  const name = requiredString(req.body.name, 'name', 120);
  const location = latLng(req.body.location_lat, req.body.location_lng);
  const db = getDb();
  const id = uuidv4();
  const resource = await db.transaction(async (tx) => {
    const row = await tx.one(
      `INSERT INTO resources (id, type, name, location_lat, location_lng, location_name, status, capacity, current_load, capabilities)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        id, type, name, location?.lat ?? null, location?.lng ?? null,
        optionalString(req.body.location_name, 'location_name', 200),
        optionalEnum(req.body.status, 'status', RESOURCE_STATUSES) ?? 'available',
        optionalInt(req.body.capacity, 'capacity', 0, 100_000) ?? 1,
        optionalInt(req.body.current_load, 'current_load', 0, 100_000) ?? 0,
        JSON.stringify(parseCapabilities(req.body.capabilities) ?? []),
      ],
    );
    await audit(tx, { entityType: 'resource', entityId: id, action: 'created', user: req.user, details: { type, name } });
    return row!;
  });
  broadcast('resource', 'upsert', resource);
  res.status(201).json(resource);
}));

router.patch('/:id', staff, route('Failed to update resource', async (req, res) => {
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    if (value === null || value === undefined) return;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  add('type', optionalEnum(req.body.type, 'type', RESOURCE_TYPES));
  add('name', optionalString(req.body.name, 'name', 120));
  add('location_name', optionalString(req.body.location_name, 'location_name', 200));
  add('status', optionalEnum(req.body.status, 'status', RESOURCE_STATUSES));
  add('capacity', optionalInt(req.body.capacity, 'capacity', 0, 100_000));
  add('current_load', optionalInt(req.body.current_load, 'current_load', 0, 100_000));
  const caps = parseCapabilities(req.body.capabilities);
  if (caps) add('capabilities', JSON.stringify(caps));
  const location = latLng(req.body.location_lat, req.body.location_lng);
  if (location) {
    add('location_lat', location.lat);
    add('location_lng', location.lng);
  }
  if (sets.length === 0) throw new ValidationError('No valid fields to update');

  const db = getDb();
  const updated = await db.transaction(async (tx) => {
    values.push(req.params.id);
    const row = await tx.one(`UPDATE resources SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values);
    if (!row) return null;
    await audit(tx, { entityType: 'resource', entityId: row.id, action: 'updated', user: req.user, details: req.body });
    return row;
  });
  if (!updated) {
    res.status(404).json({ error: 'Resource not found' });
    return;
  }
  broadcast('resource', 'upsert', updated);
  if (req.body.status !== undefined || req.body.capabilities !== undefined || req.body.current_load !== undefined || req.body.capacity !== undefined) {
    reoptimize(updated.status === 'unavailable' ? 'resource_unavailable' : updated.status === 'available' ? 'resource_available' : 'resource_status_changed', updated.id);
  }
  res.json(updated);
}));

// Live GPS position from a field unit's device. Not audited per ping: that would flood the audit log.
router.post('/:id/location', route('Failed to update location', async (req, res) => {
  const user = req.user!;
  const isOwnUnit = user.role === 'field_reporter' && user.resource_id === req.params.id;
  if (user.role === 'field_reporter' && !isOwnUnit) {
    res.status(403).json({ error: 'You can only share the location of your own unit' });
    return;
  }
  const location = latLng(req.body.lat, req.body.lng);
  if (!location) throw new ValidationError('lat and lng are required');
  const accuracy = optionalNumber(req.body.accuracy, 'accuracy', 0, 100_000);

  const updated = await getDb().one(
    `UPDATE resources SET location_lat = $1, location_lng = $2, location_accuracy_m = $3,
       location_updated_at = now(), updated_at = now()
     WHERE id = $4 RETURNING *`,
    [location.lat, location.lng, accuracy, req.params.id],
  );
  if (!updated) {
    res.status(404).json({ error: 'Resource not found' });
    return;
  }
  broadcast('resource', 'upsert', updated);
  res.json(updated);
}));

export default router;
