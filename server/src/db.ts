import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { MIGRATIONS } from './migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
// PGLITE_DATA_DIR lets tests use an isolated database, e.g. "memory://" (nothing written to disk).
const PGLITE_DIR = process.env.PGLITE_DATA_DIR || path.join(DATA_DIR, 'pgdata');
const IN_MEMORY = PGLITE_DIR.startsWith('memory://');
const LOCK_FILE = process.env.PGLITE_DATA_DIR ? `${PGLITE_DIR}.lock` : path.join(DATA_DIR, 'pgdata.lock');

export type Row = Record<string, any>;

export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Runs one or more statements without parameters. */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  kind: 'postgres' | 'pglite';
  /**
   * Runs fn inside a transaction. Inside fn, use only the `tx` handle: with the embedded
   * database, calling getDb() from inside a transaction waits on the transaction itself.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

let db: Database | null = null;

export function getDb(): Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function queryable(
  run: (sql: string, params: unknown[]) => Promise<Row[]>,
  exec: (sql: string) => Promise<void>,
): Queryable {
  return {
    query: <T>(sql: string, params: unknown[] = []) => run(sql, params) as Promise<T[]>,
    one: async <T>(sql: string, params: unknown[] = []) => (await run(sql, params))[0] as T | undefined,
    exec,
  };
}

async function openPostgres(connectionString: string): Promise<Database> {
  pg.types.setTypeParser(20, (v) => parseInt(v, 10));
  pg.types.setTypeParser(1700, (v) => parseFloat(v));
  const pool = new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) });
  await pool.query('SELECT 1');

  const base = queryable(
    async (sql, params) => (await pool.query(sql, params)).rows,
    async (sql) => { await pool.query(sql); },
  );

  return {
    kind: 'postgres',
    ...base,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(queryable(
          async (sql, params) => (await client.query(sql, params)).rows,
          async (sql) => { await client.query(sql); },
        ));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// The embedded database files must only be opened by one process at a time.
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (pid && pid !== process.pid && pidIsAlive(pid)) {
      throw new Error(
        `The embedded database is already open in another process (pid ${pid}). ` +
        'Stop the running server first, or set DATABASE_URL to use a PostgreSQL server.',
      );
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    // lock already gone
  }
}

async function openPglite(): Promise<Database> {
  if (!IN_MEMORY) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    acquireLock();
  }
  let lite: PGlite;
  try {
    lite = new PGlite(PGLITE_DIR);
    await lite.waitReady;
  } catch (err) {
    releaseLock();
    throw err;
  }

  const base = queryable(
    async (sql, params) => (await lite.query<Row>(sql, params)).rows,
    async (sql) => { await lite.exec(sql); },
  );

  return {
    kind: 'pglite',
    ...base,
    transaction: (fn) => lite.transaction((tx) => fn(queryable(
      async (sql, params) => (await tx.query<Row>(sql, params)).rows,
      async (sql) => { await tx.exec(sql); },
    ))),
    async close() {
      await lite.close();
      if (!IN_MEMORY) releaseLock();
    },
  };
}

async function runMigrations(database: Database) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const migration of MIGRATIONS) {
    await database.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7224001)');
      const done = await tx.one('SELECT id FROM schema_migrations WHERE id = $1', [migration.id]);
      if (done) return;
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [migration.id, migration.name]);
      console.log(`Applied migration ${migration.id}_${migration.name}`);
    });
  }
}

export async function initDb(): Promise<Database> {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  const opened = url ? await openPostgres(url) : await openPglite();
  try {
    await runMigrations(opened);
  } catch (err) {
    await opened.close();
    throw err;
  }
  db = opened;
  console.log(url ? 'Connected to PostgreSQL (DATABASE_URL)' : `Using embedded PostgreSQL (PGlite) at ${PGLITE_DIR}`);
  return db;
}

export async function closeDb() {
  if (!db) return;
  const current = db;
  db = null;
  await current.close();
}
