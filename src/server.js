// Точка входа: HTTP + фоновые циклы (опрос таблицы, распределение, вебхуки, пометки в шит).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openMigrated } from './db/index.js';
import { createHandler } from './http/api.js';
import { withAuth, authEnabled } from './http/auth.js';
import { importBatch } from './core/importer.js';
import { dispatchQueue } from './core/queue.js';
import { flushOutbox } from './core/webhooks.js';
import { flushSheetWrites, sheetReadonly } from './core/sheetWriter.js';
import { getConfig } from './core/columns.js';
import { enrichPending } from './core/enrichment.js';
import { deliverPending } from './core/argusDelivery.js';

loadEnv();

const db = openMigrated();
const log = (...a) => console.log(new Date().toISOString(), ...a);

const columns = getConfig();   // упадём на старте, если схема таблицы кривая
log(`схема таблицы: лист "${columns.sheet}", статус в колонке ${columns.statusColumn}`);
if (sheetReadonly()) log('SHEET_READONLY=1 — таблицу только читаем, пометки копятся в очереди');

async function importNow() {
  const { fetchBatch } = await import('./adapters/sheets.js');
  const cfg = getConfig();
  const stats = importBatch(db, await fetchBatch(cfg), cfg);
  const dispatched = dispatchQueue(db);
  if (stats.created || stats.in_work || stats.declined || dispatched.assigned) {
    log('import', JSON.stringify(stats), 'dispatch', JSON.stringify(dispatched));
  }
  return { ...stats, ...dispatched };
}

const server = createServer(withAuth(createHandler(db, { importNow })));
log(authEnabled() ? `вход по логину: ${process.env.AUTH_USER}` : 'вход открыт (AUTH_USER не задан)');
const port = Number(process.env.PORT) || 3000;
server.listen(port, () => log(`lead-router на http://localhost:${port}`));

// --- фоновые циклы ---
// опрос таблицы раз в минуту: новые строки в очередь, статусы из СРМ обратно к нам
every(Number(process.env.IMPORT_INTERVAL_MS) || 60_000, async () => {
  if (!process.env.SHEETS_SPREADSHEET_ID) return;
  await importNow();
});

every(30_000, async () => {
  if (process.env.B24_WEBHOOK_URL) {
    const enriched = await enrichPending(db);
    if (enriched.picked) log('обогащение', JSON.stringify(enriched));
  }
  const { assigned } = dispatchQueue(db);
  if (assigned) log(`распределено: ${assigned}`);

  if (process.env.ARGUS_API_URL) {
    const delivered = await deliverPending(db);
    if (delivered.picked) log('в Аргус', JSON.stringify(delivered));
  }
});

every(10_000, async () => {
  const out = await flushOutbox(db);
  if (out.picked) log('outbox', JSON.stringify(out));
  if (process.env.SHEETS_SPREADSHEET_ID) {
    const sheet = await flushSheetWrites(db);
    if (sheet.picked) log('sheet', JSON.stringify(sheet));
  }
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
