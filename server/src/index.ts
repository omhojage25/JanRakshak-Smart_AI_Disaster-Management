import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { closeDb, getDb, initDb } from './db.js';
import { initAuth, requireAuth, requireRole } from './auth.js';
import { closeRealtime, initRealtime } from './realtime.js';
import { route } from './http.js';
import { ACTIVE_INCIDENT_STATUSES, sqlList } from './constants.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import incidentRoutes from './routes/incidents.js';
import resourceRoutes from './routes/resources.js';
import reportRoutes from './routes/reports.js';
import publicReportRoutes from './routes/publicReports.js';
import assignmentRoutes, { recommendRouter } from './routes/assignments.js';
import auditRoutes from './routes/audit.js';
import notificationRoutes from './routes/notifications.js';
import routingRoutes from './routes/routing.js';
import blockedRoadRoutes from './routes/blockedRoads.js';
import { getRoutingProvider } from './services/routing.js';
import { checkEscalations } from './services/escalation.js';
import { predictExhaustion } from './services/prediction.js';
import { startScheduler } from './services/scheduler.js';
import { seedDemoData } from './seedData.js';
import { loadRiskModel } from './services/riskModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
if (isProduction) process.env.NODE_ENV = 'production';
const PORT = Number(process.env.PORT ?? 3001);
const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist');

initAuth(isProduction);

// XGBoost risk-classification POC: load once at start-up so a missing/invalid model file is reported
// immediately. If it fails, incidents are still created and marked "risk assessment unavailable".
try {
  console.log(`Risk model loaded: ${loadRiskModel().version}`);
} catch (err) {
  console.error('Risk model could not be loaded; risk assessments will be unavailable:', (err as Error).message);
}
const routing = getRoutingProvider();
if (routing) console.log(`Road routing backend: ${routing.id}`);
else console.warn('ROUTING_URL is not set: road routing unavailable, allocation runs will be marked DEGRADED.');
const db = await initDb();

const userCount = await db.one<{ count: number }>('SELECT COUNT(*)::int AS count FROM users');
if (!userCount?.count) {
  if (isProduction) {
    console.warn('No user accounts exist. Run "npm run seed" (demo data) or create an admin with "npm run create-admin".');
  } else {
    console.log('Empty database: loading the Mumbai demo scenario...');
    const accounts = await db.transaction((tx) => seedDemoData(tx));
    console.log('Demo accounts (change these before real use):');
    for (const a of accounts) console.log(`  ${a.role.padEnd(15)} ${a.username} / ${a.password}`);
  }
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', route('Health check failed', async (_req, res) => {
  await getDb().one('SELECT 1 AS ok');
  res.json({ status: 'ok', database: getDb().kind, timestamp: new Date().toISOString() });
}));

app.use('/api/auth', authRoutes);

// Citizen intake needs no login, so it is mounted before the auth gate below.
app.use('/api/public/reports', publicReportRoutes);

// Everything below requires a signed-in user.
app.use('/api', requireAuth);
app.use('/api/users', requireRole('admin'), userRoutes);
app.use('/api', recommendRouter);
app.use('/api/incidents', incidentRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/audit', requireRole('admin', 'coordinator'), auditRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/routes', routingRoutes);

app.use('/api/blocked-roads', blockedRoadRoutes);

app.get('/api/escalations', route('Failed to check escalations', async (_req, res) => {
  const incidents = await getDb().query(
    `SELECT * FROM incidents WHERE status IN ('triage', 'dispatched') AND parent_incident_id IS NULL`,
  );
  res.json(checkEscalations(incidents as never));
}));

app.get('/api/predictions', route('Failed to compute predictions', async (_req, res) => {
  const resources = await getDb().query('SELECT * FROM resources');
  const incidents = await getDb().query(`SELECT * FROM incidents WHERE status IN (${sqlList(ACTIVE_INCIDENT_STATUSES)})`);
  res.json(predictExhaustion(resources as never, incidents as never));
}));

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (isProduction) {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.warn(`No frontend build found at ${DIST_DIR}. Run "npm run build" first.`);
  }
  app.use('/assets', express.static(path.join(DIST_DIR, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(DIST_DIR, { index: false, maxAge: 0 }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON' });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' });
    return;
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
initRealtime(server);
const stopScheduler = startScheduler();

server.listen(PORT, () => {
  console.log(`JanRakshak server running on http://localhost:${PORT}${isProduction ? ' (production)' : ''}`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  stopScheduler();
  await closeRealtime().catch(() => {});
  server.close();
  await closeDb().catch((err) => console.error('Error closing database:', err));
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
