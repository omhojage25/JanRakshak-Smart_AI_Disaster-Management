import { Router } from 'express';
import { getDb } from '../db.js';
import { route } from '../http.js';

const router = Router();

router.get('/', route('Failed to fetch notifications', async (req, res) => {
  const rows = await getDb().query(
    `SELECT n.*, (nr.user_id IS NOT NULL) AS read
     FROM notifications n
     LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $1
     ORDER BY n.created_at DESC LIMIT 50`,
    [req.user!.id],
  );
  res.json(rows);
}));

router.post('/read-all', route('Failed to update notifications', async (req, res) => {
  await getDb().query(
    `INSERT INTO notification_reads (user_id, notification_id)
     SELECT $1, id FROM notifications ON CONFLICT DO NOTHING`,
    [req.user!.id],
  );
  res.json({ ok: true });
}));

router.post('/:id/read', route('Failed to update notification', async (req, res) => {
  const exists = await getDb().one('SELECT id FROM notifications WHERE id = $1', [req.params.id]);
  if (!exists) {
    res.status(404).json({ error: 'Notification not found' });
    return;
  }
  await getDb().query(
    'INSERT INTO notification_reads (user_id, notification_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user!.id, req.params.id],
  );
  res.json({ ok: true });
}));

export default router;
