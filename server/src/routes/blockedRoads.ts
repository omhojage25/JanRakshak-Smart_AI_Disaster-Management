import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { requireRole } from '../auth.js';
import { route } from '../http.js';
import { latLng, optionalString, ValidationError } from '../validate.js';
import { audit } from '../services/audit.js';
import { broadcast } from '../realtime.js';
import { reoptimize } from '../services/allocation/reoptimize.js';

const router = Router();
const staff = requireRole('admin', 'coordinator');

router.get('/', route('Failed to fetch blocked roads', async (_req, res) => {
  res.json(await getDb().query('SELECT * FROM blocked_roads ORDER BY created_at DESC'));
}));

// A road segment that vehicles cannot use. Routing avoids it; the optimizer re-plans affected units.
router.post('/', staff, route('Failed to add blocked road', async (req, res) => {
  const start = latLng(req.body.start_lat, req.body.start_lng, 'start');
  const end = latLng(req.body.end_lat, req.body.end_lng, 'end');
  if (!start || !end) throw new ValidationError('start_lat, start_lng, end_lat and end_lng are required');
  const incidentId = optionalString(req.body.incident_id, 'incident_id', 64);
  const db = getDb();
  const row = await db.transaction(async (tx) => {
    if (incidentId && !(await tx.one('SELECT id FROM incidents WHERE id = $1', [incidentId]))) {
      throw new ValidationError('incident_id does not exist');
    }
    const r = (await tx.one(
      `INSERT INTO blocked_roads (id, incident_id, start_lat, start_lng, end_lat, end_lng, road_name, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [uuidv4(), incidentId, start.lat, start.lng, end.lat, end.lng,
        optionalString(req.body.road_name, 'road_name', 200), optionalString(req.body.reason, 'reason', 500)],
    ))!;
    await audit(tx, { entityType: 'blocked_road', entityId: r.id, incidentId, action: 'road_blocked', user: req.user, details: { road_name: r.road_name, reason: r.reason } });
    return r;
  });
  broadcast('blocked_road', 'upsert', row);
  reoptimize('road_blocked', row.id);
  res.status(201).json(row);
}));

router.delete('/:id', staff, route('Failed to remove blocked road', async (req, res) => {
  const db = getDb();
  const row = await db.transaction(async (tx) => {
    const r = await tx.one('DELETE FROM blocked_roads WHERE id = $1 RETURNING *', [req.params.id]);
    if (r) await audit(tx, { entityType: 'blocked_road', entityId: r.id, incidentId: r.incident_id, action: 'road_cleared', user: req.user, details: { road_name: r.road_name } });
    return r;
  });
  if (!row) {
    res.status(404).json({ error: 'Blocked road not found' });
    return;
  }
  broadcast('blocked_road', 'delete', { id: row.id });
  reoptimize('road_cleared', row.id);
  res.json({ ok: true });
}));

export default router;
