import 'dotenv/config';
import { closeDb, initDb } from './db.js';
import { seedDemoData } from './seedData.js';

async function main() {
  const db = await initDb();
  const accounts = await db.transaction((tx) => seedDemoData(tx));
  console.log('\nSeed complete. Demo accounts:');
  for (const a of accounts) console.log(`  ${a.role.padEnd(15)} ${a.username} / ${a.password}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(`Seed failed: ${(err as Error).message}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
