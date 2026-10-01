import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { broadcast } from '../realtime.js';
import type { NotificationType } from '../constants.js';

const LEVEL: Record<NotificationType, number> = { info: 0, success: 0, warning: 1, critical: 2 };

export interface NewNotification {
  type: NotificationType;
  title: string;
  message: string;
  incidentId?: string | null;
}

/** Stores a notification and pushes it to every connected client. Call outside transactions. */
export async function notify(n: NewNotification) {
  const row = await getDb().one(
    `INSERT INTO notifications (id, type, title, message, incident_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [uuidv4(), n.type, n.title, n.message, n.incidentId ?? null],
  );
  if (!row) return;
  broadcast('notification', 'upsert', { ...row, read: false });
  sendWebhook(row).catch((err) => console.error('[notify] webhook delivery failed:', (err as Error).message));
}

async function sendWebhook(row: Record<string, unknown>) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  const minLevel = (process.env.NOTIFY_WEBHOOK_MIN_LEVEL ?? 'warning') as NotificationType;
  const type = row.type as NotificationType;
  if (LEVEL[type] < (LEVEL[minLevel] ?? 1)) return;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'janrakshak',
      text: `[${type.toUpperCase()}] ${row.title}: ${row.message}`,
      notification: row,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}
