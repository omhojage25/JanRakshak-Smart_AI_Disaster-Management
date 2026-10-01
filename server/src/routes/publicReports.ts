import { Router } from 'express';
import { route } from '../http.js';
import { classifyReport } from '../services/classifier.js';
import { WorkflowError } from '../services/workflow.js';
import { resolveLocation } from '../services/locate.js';
import { createReportFromMessage, existingReportResult, parseReportBody, reporterFix } from './reports.js';
import { getDb } from '../db.js';
import { buildPublicView } from '../services/publicTracking.js';

const router = Router();

// ── Simple per-IP rate limit (no auth here, so this is the only abuse guard). ──
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 8;
const hits = new Map<string, { count: number; firstAt: number }>();

function clientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip: string): boolean {
  const entry = hits.get(ip);
  const now = Date.now();
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    hits.set(ip, { count: 1, firstAt: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

// Occasionally forget old entries so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now - entry.firstAt > WINDOW_MS) hits.delete(ip);
  }
}, WINDOW_MS).unref();

router.post('/', route('Failed to submit report', async (req, res) => {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    throw new WorkflowError('Too many reports from this device. Please wait a few minutes and try again.', 429, 'rate_limited');
  }

  const fields = parseReportBody(req.body ?? {});
  const replay = await existingReportResult(fields.clientId);
  if (replay) {
    res.status(200).json(replay);
    return;
  }
  const classification = await classifyReport(fields.rawMessage);
  const location = await resolveLocation(classification, fields.rawMessage, reporterFix(fields));

  // Staff can verify a doubtful pin with the caller; an anonymous report cannot be followed up, so
  // it must be placeable: no placeholder, no AI-only guess, no ambiguous same-name place.
  if (location.meta.precision === 'unverified' || location.meta.precision === 'ai_estimate') {
    const why = location.meta.ambiguous
      ? `Several places match "${location.meta.structured.place ?? location.name}". Please add the area/landmark nearby, or turn on "Attach my current location", and resend.`
      : 'We could not find a location in your message. Please turn on "Attach my current location" or mention the exact place (building, street, landmark, area) and resend.';
    throw new WorkflowError(why, 422, 'location_required');
  }

  const result = await createReportFromMessage(fields, classification, location, null);
  res.status(result.is_duplicate || 'already_processed' in result ? 200 : 201).json(result);
}));

// Citizen tracking: public-safe view only. Live updates follow on the /public Socket.IO namespace.
router.get('/track/:id', route('Failed to load incident status', async (req, res) => {
  const id = String(req.params.id);
  const view = id.length <= 64 ? await buildPublicView(getDb(), id) : null;
  if (!view) {
    res.status(404).json({ error: 'No report found with this tracking ID' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(view);
}));

export default router;
