import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from './db.js';
import type { Role } from './constants.js';

export interface AuthUser {
  id: string;
  username: string;
  full_name: string;
  role: Role;
  resource_id: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const SESSION_COOKIE = 'jr_session';
const SESSION_TTL_SEC = 12 * 60 * 60;

let secret = '';
let cookieSecure = false;

export function initAuth(isProduction: boolean) {
  cookieSecure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction;
  const configured = process.env.JWT_SECRET;
  if (configured && configured.length >= 32) {
    secret = configured;
    return;
  }
  if (isProduction) {
    throw new Error('JWT_SECRET must be set to at least 32 characters in production.');
  }
  secret = crypto.randomBytes(48).toString('hex');
  console.warn('JWT_SECRET is not set: using a temporary secret, so everyone is logged out when the server restarts.');
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function scrypt(password: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 200) return 'Password is too long';
  return null;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function issueSession(res: Response, user: { id: string; session_version: number }) {
  const token = jwt.sign({ sub: user.id, sv: user.session_version }, secret, {
    algorithm: 'HS256',
    expiresIn: SESSION_TTL_SEC,
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure,
    maxAge: SESSION_TTL_SEC * 1000,
    path: '/',
  });
}

export function clearSession(res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: cookieSecure, path: '/' });
}

export async function userFromToken(token: string | undefined): Promise<AuthUser | null> {
  if (!token || !secret) return null;
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
  } catch {
    return null;
  }
  if (typeof payload.sub !== 'string') return null;
  const row = await getDb().one<AuthUser & { active: boolean; session_version: number }>(
    'SELECT id, username, full_name, role, resource_id, active, session_version FROM users WHERE id = $1',
    [payload.sub],
  );
  if (!row || !row.active || row.session_version !== payload.sv) return null;
  return { id: row.id, username: row.username, full_name: row.full_name, role: row.role, resource_id: row.resource_id };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = await userFromToken(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!user) {
    res.status(401).json({ error: 'Please sign in to continue' });
    return;
  }
  req.user = user;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'You do not have permission to do this' });
      return;
    }
    next();
  };
}

const FAILED_LOGIN_LIMIT = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const failedLogins = new Map<string, { count: number; firstAt: number }>();

export function isLoginBlocked(key: string): boolean {
  const entry = failedLogins.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > FAILED_LOGIN_WINDOW_MS) {
    failedLogins.delete(key);
    return false;
  }
  return entry.count >= FAILED_LOGIN_LIMIT;
}

export function recordFailedLogin(key: string) {
  const entry = failedLogins.get(key);
  if (!entry || Date.now() - entry.firstAt > FAILED_LOGIN_WINDOW_MS) {
    failedLogins.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

export function clearFailedLogins(key: string) {
  failedLogins.delete(key);
}
