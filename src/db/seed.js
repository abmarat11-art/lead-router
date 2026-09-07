// Демо-данные: четыре команды и несколько строк «из таблицы».
import { openMigrated } from './index.js';
import { importBatch } from '../core/importer.js';
import { dispatchQueue } from '../core/queue.js';

const db = openMigrated();

const team = db.prepare('INSERT OR IGNORE INTO teams (id, name, queue_order) VALUES (?, ?, ?)');
for (let i = 1; i <= 4; i++) team.run(i, `Команда ${i}`, i);

const headers = ['Дата', 'Компания', 'Контактное лицо', 'Телефон', 'Лидогенератор', 'Итог работы', 'Статус'];
const rows = [
  ['01.09.2026', 'ООО Ромашка', 'Иван', '901234567', 'Лидген-1', 'Лид', ''],
  ['01.09.2026', 'Chinor Group', 'Азиз', '+998 90 765 43 21', 'Лидген-1', 'Назначена встреча', ''],
  ['02.09.2026', 'Delta Trade', 'Сара', '+998935558877', 'Лидген-2', 'Лид', ''],
  ['02.09.2026', 'Alfa Bino', 'Тимур', '+998901112233', 'Лидген-2', 'Лид', ''],
  ['02.09.2026', 'Sifat Servis', 'Олим', '+998907776655', 'Лидген-1', 'Назначена встреча', ''],
  ['02.09.2026', '', '', '', 'Лидген-2', '', ''],
].map((cells, i) => ({ key: `Лист1:${i + 2}`, cells }));

console.log('импорт:', importBatch(db, { headers, rows }));
console.log('распределение:', dispatchQueue(db));
