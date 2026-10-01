import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { closeDb, initDb } from './db.js';
import { hashPassword, validatePassword } from './auth.js';

async function main() {
  const [username, password, ...nameParts] = process.argv.slice(2);
  const fullName = nameParts.join(' ') || 'Administrator';
  if (!username || !password) {
    console.error('Usage: npm run create-admin -- <username> <password> [full name]');
    process.exit(1);
  }
  const problem = validatePassword(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  const db = await initDb();
  const existing = await db.one('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
  if (existing) {
    await db.query(
      `UPDATE users SET password_hash = $1, role = 'admin', active = true, session_version = session_version + 1 WHERE id = $2`,
      [await hashPassword(password), existing.id],
    );
    console.log(`Updated "${username}": password reset and admin role granted.`);
  } else {
    await db.query(
      `INSERT INTO users (id, username, full_name, password_hash, role) VALUES ($1, $2, $3, $4, 'admin')`,
      [uuidv4(), username.toLowerCase(), fullName, await hashPassword(password)],
    );
    console.log(`Created admin "${username}".`);
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error(`Failed: ${(err as Error).message}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
