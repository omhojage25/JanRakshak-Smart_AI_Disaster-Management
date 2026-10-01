import { Router } from 'express';
import { getDb } from '../db.js';
import { route } from '../http.js';

const router = Router();

router.get('/', route('Failed to fetch audit log', async (req, res) => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown) => {
    params.push(String(value));
    conditions.push(`${column} = $${params.length}`);
  };
  if (req.query.entity_type) add('entity_type', req.query.entity_type);
  if (req.query.entity_id) add('entity_id', req.query.entity_id);
  if (req.query.incident_id) add('incident_id', req.query.incident_id);

  const parsed = parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
  params.push(limit);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  res.json(await getDb().query(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params));
}));

export default router;
