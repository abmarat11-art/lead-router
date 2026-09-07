// Демо-данные, чтобы пощупать интерфейс до подключения реального шита.
import { openMigrated } from './index.js';
import { importBatch } from '../core/importer.js';

const db = openMigrated();

db.prepare("INSERT OR IGNORE INTO teams (id, name, strategy) VALUES (1, 'Команда А', 'round_robin')").run();
db.prepare("INSERT OR IGNORE INTO teams (id, name, strategy) VALUES (2, 'Команда Б', 'balance')").run();

const emp = db.prepare(
  'INSERT OR IGNORE INTO employees (id, team_id, name, tg_username, langs, daily_limit, queue_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
emp.run(1, 1, 'Аня', '@anya', '["ru"]', 0, 1);
emp.run(2, 1, 'Бек', '@bek', '["ru","uz"]', 10, 2);
emp.run(3, 1, 'Вика', '@vika', '["uz"]', 0, 3);
emp.run(4, 2, 'Гуля', '@gulya', '["ru","en"]', 0, 1);

const headers = ['Дата', 'Компания', 'Контактное лицо', 'Телефон', 'Язык клиента', 'Лидогенератор', 'Итог работы', 'Регион'];
const rows = [
  ['01.09.2026', 'ООО Ромашка', 'Иван', '901234567', 'русский', 'Лидген-1', 'Лид', 'Ташкент'],
  ['01.09.2026', 'Chinor Group', 'Азиз', '+998 90 765 43 21', 'узбекский', 'Лидген-1', 'Назначена встреча', 'Самарканд'],
  ['02.09.2026', 'Delta Trade', 'Sarah', '+998935558877', 'english', 'Лидген-2', 'Лид', 'Ташкент'],
  ['02.09.2026', '', '', '', '', 'Лидген-2', '', ''],
].map((cells, i) => ({ key: `Лист1:${i + 2}`, cells }));

console.log(importBatch(db, { headers, rows }, { defaultTeamId: 1 }));
