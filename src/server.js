// Точка входа: HTTP + фоновые циклы (импорт, протухание предложений, отправка вебхуков).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openMigrated } from './db/index.js';
import { createHandler } from './http/api.js';
import { importBatch } from './core/importer.js';
import { expireOffers, dispatchQueue } from './core/router.js';
import { flushOutbox } from './core/webhooks.js';

loadEnv();

const db = openMigrated();
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function importNow() {
  const { fetchBatch } = await import('./adapters/sheets.js');
  const batch = await fetchBatch();
  const stats = importBatch(db, batch, { defaultTeamId: Number(process.env.DEFAULT_TEAM_ID) || null });
  log('import', JSON.stringify(stats));
  return stats;
}

const server = createServer(createHandler(db, { importNow }));
const port = Number(process.env.PORT) || 3000;
server.listen(port, () => log(`lead-router на http://localhost:${port}`));

// --- фоновые циклы ---
every(Number(process.env.IMPORT_INTERVAL_MS) || 120_000, async () => {
  if (!process.env.SHEETS_SPREADSHEET_ID) return;
  await importNow();
});

every(30_000, () => {
  const expired = expireOffers(db);
  const { offered } = dispatchQueue(db);
  if (expired || offered) log(`tick: протухло ${expired}, предложено ${offered}`);
});

every(10_000, async () => {
  const res = await flushOutbox(db);
  if (res.picked) log('outbox', JSON.stringify(res));
});

function every(ms, fn) {
  const run = async () => {
    try { await fn(); } catch (err) { log('ошибка цикла:', err.message); }
  };
  setInterval(run, ms);
  run();
}

// .env без зависимостей
function loadEnv() {
  try {
    const text = readFileSync('.env', 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env необязателен */ }
}
