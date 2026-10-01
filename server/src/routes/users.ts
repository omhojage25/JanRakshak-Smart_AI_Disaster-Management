import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { hashPassword, validatePassword } from '../auth.js';
import { route } from '../http.js';
import { ROLES } from '../constants.js';
import { optionalBool, optionalEnum, optionalString, requiredString, ValidationError } from '../validate.js';
import { audit } from '../services/audit.js';
import { disconnectUser } from '../realtime.js';

const router = Router();

const USER_COLUMNS = 'id, username, full_name, role, resource_id, active, created_at, last_login_at';

async function assertResourceExists(resourceId: string | null) {
  if (!resourceId) return;
  const r = await getDb().one('SELECT id FROM resources WHERE id = $1', [resourceId]);
  if (!r) throw new ValidationError('Linked resource does not exist');
}

router.get('/', route('Failed to fetch users', async (_req, res) => {
  const users = await getDb().query(
    `SELECT u.id, u.username, u.full_name, u.role, u.resource_id, u.active, u.created_at, u.last_login_at,
            r.name AS resource_name
     FROM users u LEFT JOIN resources r ON u.resource_id = r.id
     ORDER BY u.created_at`,
  );
  res.json(users);
}));

router.post('/', route('Failed to create user', async (req, res) => {
  const username = requiredString(req.body.username, 'Username', 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new ValidationError('Username may only use letters, numbers, dots, dashes and underscores (3-40 characters)');
  }
  const fullName = requiredString(req.body.full_name, 'Full name', 100);
  const role = optionalEnum(req.body.role, 'Role', ROLES);
  if (!role) throw new ValidationError('Role is required');
  const problem = validatePassword(req.body.password);
  if (problem) throw new ValidationError(problem);
  const resourceId = optionalString(req.body.resource_id, 'Linked resource', 64);
  await assertResourceExists(resourceId);

  const db = getDb();
  const existing = await db.one('SELECT id FROM users WHERE username = $1', [username]);
  if (existing) {
    res.status(409).json({ error: 'That username is already taken' });
    return;
  }
  const user = await db.one(
    `INSERT INTO users (id, username, full_name, password_hash, role, resource_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${USER_COLUMNS}`,
    [uuidv4(), username, fullName, await hashPassword(req.body.password), role, resourceId],
  );
  await audit(db, { entityType: 'user', entityId: user!.id, action: 'created', user: req.user, details: { username, role } });
  res.status(201).json(user);
}));

router.patch('/:id', route('Failed to update user', async (req, res) => {
  const db = getDb();
  const target = await db.one('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const fullName = optionalString(req.body.full_name, 'Full name', 100);
  const role = optionalEnum(req.body.role, 'Role', ROLES);
  const active = optionalBool(req.body.active, 'Active');
  const password = req.body.password;
  if (password !== undefined && password !== '') {
    const problem = validatePassword(password);
    if (problem) throw new ValidationError(problem);
  }
  const resourceProvided = Object.prototype.hasOwnProperty.call(req.body, 'resource_id');
  const resourceId = resourceProvided ? optionalString(req.body.resource_id, 'Linked resource', 64) : undefined;
  if (resourceId) await assertResourceExists(resourceId);

  const isSelf = target.id === req.user!.id;
  if (isSelf && ((role && role !== 'admin') || active === false)) {
    throw new ValidationError('You cannot remove your own admin access');
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    sets.push(`${sql} = $${values.length}`);
  };
  if (fullName) add('full_name', fullName);
  if (role) add('role', role);
  if (active !== null) add('active', active);
  if (resourceProvided) add('resource_id', resourceId ?? null);
  if (password) add('password_hash', await hashPassword(password));
  if (sets.length === 0) throw new ValidationError('Nothing to update');

  const revokesSessions = Boolean(password) || (role && role !== target.role) || active === false;
  if (revokesSessions) sets.push('session_version = session_version + 1');

  values.push(target.id);
  const user = await db.one(`UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${USER_COLUMNS}`, values);
  await audit(db, {
    entityType: 'user', entityId: target.id, action: 'updated', user: req.user,
    details: { role: role ?? undefined, active: active ?? undefined, password_reset: Boolean(password) || undefined, resource_id: resourceProvided ? resourceId : undefined },
  });
  if (revokesSessions) disconnectUser(target.id);
  res.json(user);
}));

router.delete('/:id', route('Failed to delete user', async (req, res) => {
  if (req.params.id === req.user!.id) throw new ValidationError('You cannot delete your own account');
  const db = getDb();
  const target = await db.one('DELETE FROM users WHERE id = $1 RETURNING id, username', [req.params.id]);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await audit(db, { entityType: 'user', entityId: target.id, action: 'deleted', user: req.user, details: { username: target.username } });
  disconnectUser(target.id);
  res.json({ ok: true });
}));

export default router;
