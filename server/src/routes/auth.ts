import { Router } from 'express';
import { getDb } from '../db.js';
import {
  clearSession, clearFailedLogins, hashPassword, isLoginBlocked, issueSession, recordFailedLogin,
  requireAuth, validatePassword, verifyPassword,
} from '../auth.js';
import { route } from '../http.js';
import { audit } from '../services/audit.js';
import { disconnectUser } from '../realtime.js';

const router = Router();

// Compared against when the username does not exist, so response time does not reveal valid usernames.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

router.post('/login', route('Sign-in failed', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const throttleKey = `${req.ip}|${username}`;
  if (isLoginBlocked(throttleKey)) {
    res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    return;
  }

  const db = getDb();
  const user = await db.one('SELECT * FROM users WHERE username = $1', [username]);
  const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid || !user.active) {
    recordFailedLogin(throttleKey);
    res.status(401).json({ error: 'Incorrect username or password' });
    return;
  }

  clearFailedLogins(throttleKey);
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  issueSession(res, user as { id: string; session_version: number });
  await audit(db, {
    entityType: 'user', entityId: user.id, action: 'login',
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, resource_id: user.resource_id },
  });
  res.json({
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, resource_id: user.resource_id },
  });
}));

router.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, route('Could not change password', async (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  const problem = validatePassword(new_password);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  const db = getDb();
  const row = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
  if (!row || typeof current_password !== 'string' || !(await verifyPassword(current_password, row.password_hash))) {
    res.status(400).json({ error: 'Current password is incorrect' });
    return;
  }
  const updated = await db.one(
    'UPDATE users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING id, session_version',
    [await hashPassword(new_password), req.user!.id],
  );
  await audit(db, { entityType: 'user', entityId: req.user!.id, action: 'password_changed', user: req.user });
  disconnectUser(req.user!.id);
  issueSession(res, updated as { id: string; session_version: number });
  res.json({ ok: true });
}));

export default router;
