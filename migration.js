import { createStore } from './storage.js';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

async function migrate() {
  const store = await createStore({ __dirname, DATABASE_URL });
  console.log('Connecting to DB...');

  const pending = await store.pendingAll();

  for (const [id, rec] of Object.entries(pending)) {
    if (typeof rec.delta === 'string') rec.delta = parseFloat(rec.delta);
    if (!Number.isFinite(rec.delta)) continue;
    console.log(`Updating pending: ${id}, delta=${rec.delta}`);
    await store.pendingAdd(rec);
  }

  console.log('Migration finished ✅');
}

migrate()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
