// Обнуление перед боевым запуском: всё, что накопилось в таблице до старта, не считается.
//
//   node scripts/launch-reset.js <первая боевая строка>
//
// Что делает: бэкап базы в data/backups/, стирает компании, назначения, журнал, очереди
// в Аргус/таблицу/телеграм, курсоры и долги очередей; ставит firstDataRow в config/columns.json.
// Команды, их состав и привязки к телеграму НЕ трогает. Службу после этого перезапустить.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const row = Number(process.argv[2]);
if (!Number.isInteger(row) || row < 2) {
  console.error('укажи номер первой боевой строки таблицы, например: node scripts/launch-reset.js 12');
  process.exit(1);
}
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { openMigrated } = await import('../src/db/index.js');

const dbPath = process.env.DB_PATH || 'data/lead-router.db';
mkdirSync('data/backups', { recursive: true });
const backup = `data/backups/before-launch-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
const db = openMigrated(dbPath);
db.exec(`VACUUM INTO '${backup}'`); // с учётом WAL, а не копия файла
console.log('бэкап:', backup);
const before = db.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
db.exec(`
  DELETE FROM sheet_writes;
  DELETE FROM webhook_outbox;
  DELETE FROM tg_outbox;
  DELETE FROM feedback;
  DELETE FROM queue_priority;
  DELETE FROM assignments;
  DELETE FROM events;
  DELETE FROM leads;
  UPDATE queue_state SET cursor = 0;
`);
console.log(`стёрто компаний: ${before}; курсоры и долги обнулены, команды на месте`);

const cfgPath = 'config/columns.json';
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
cfg.firstDataRow = row;
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`firstDataRow = ${row}; строки выше в таблице контур не читает`);
console.log('дальше: launchctl kickstart -k gui/$(id -u)/net.at-km.lead-router');
