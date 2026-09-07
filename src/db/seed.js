// Базовые данные: четыре команды. Демо-строки — только по флагу SEED_DEMO_ROWS=1:
// боевая таблица использует те же ключи строк (Лист1:2...), и фикстуры их затирают.
import { openMigrated } from './index.js';
import { importBatch } from '../core/importer.js';
import { dispatchQueue } from '../core/queue.js';
import { getConfig } from '../core/columns.js';
import { toBatch } from '../adapters/sheets.js';

const db = openMigrated();

const team = db.prepare('INSERT OR IGNORE INTO teams (id, name, queue_order) VALUES (?, ?, ?)');
for (let i = 1; i <= 4; i++) team.run(i, `Команда ${i}`, i);

// Колонки как в config/columns.json: A дата, B компания, C контакт, D телефон,
// E лидген, F тип лида, G статус.
const cfg = getConfig();
const values = [
  ['Дата', 'Компания', 'Контактное лицо', 'Телефон', 'Лидогенератор', 'Тип лида', 'Статус'],
  ['01.09.2026', 'ООО Ромашка', 'Иван', '901234567', 'Лидген-1', 'Лид', ''],
  ['01.09.2026', 'Chinor Group', 'Азиз', '+998 90 765 43 21', 'Лидген-1', 'Встреча', ''],
  ['02.09.2026', 'Delta Trade', 'Сара', '+998935558877', 'Лидген-2', 'лид', ''],
  ['02.09.2026', 'Alfa Bino', 'Тимур', '+998901112233', 'Лидген-2', 'Лид', ''],
  ['02.09.2026', 'Sifat Servis', 'Олим', '+998907776655', 'Лидген-1', 'встреча', ''],
  ['02.09.2026', '', '', '', 'Лидген-2', '', ''],
];

if (process.env.SEED_DEMO_ROWS === '1') {
  console.log('импорт:', importBatch(db, toBatch(values, cfg), cfg));
  console.log('распределение:', dispatchQueue(db));
} else {
  console.log('команды готовы; демо-строки пропущены (SEED_DEMO_ROWS=1 — залить их)');
}
