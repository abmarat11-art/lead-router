import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import { importBatch, releaseFromQuarantine } from '../src/core/importer.js';
import { toBatch } from '../src/adapters/sheets.js';
import { resolveConfig, DEFAULT_CONFIG } from '../src/core/columns.js';

// A дата | B компания | C контакт | D телефон | E лидген | F тип лида | G статус
const CFG = resolveConfig(DEFAULT_CONFIG);
const HEAD = ['Дата', 'Компания', 'Контактное лицо', 'Телефон', 'Лидогенератор', 'Тип лида', 'Статус'];
const row = (over = {}) => {
  const base = ['01.09.2026', 'ООО Ромашка', 'Иван', '+998 90 123 45 67', 'Аня', 'Лид', ''];
  Object.entries(over).forEach(([i, v]) => { base[i] = v; });
  return base;
};
const batch = (...rows) => toBatch([HEAD, ...rows], CFG);
const load = (db, ...rows) => importBatch(db, batch(...rows), CFG);

function setup(teams = 4) {
  const db = openMigrated(':memory:');
  const add = db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (?, ?, ?)');
  for (let i = 1; i <= teams; i++) add.run(i, `Команда ${i}`, i);
  return db;
}

test('строка с пустым статусом становится новой компанией в пуле', () => {
  const db = setup();
  assert.equal(load(db, row()).created, 1);
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.status, 'new');
  assert.equal(lead.kind, 'lead');
  assert.equal(lead.phone, '+998901234567');
});

test('повторный проход по неизменной строке ничего не делает', () => {
  const db = setup();
  load(db, row());
  assert.equal(load(db, row()).skipped, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM leads').get().c, 1);
});

test('СРМ поставила «в работе» — контур это подхватывает', () => {
  const db = setup();
  load(db, row());
  db.prepare("UPDATE leads SET status = 'assigned', assigned_team = 1").run();
  db.prepare('INSERT INTO assignments (lead_id, team_id) VALUES (1, 1)').run();

  const stats = load(db, row({ 6: 'В работе' }));
  assert.equal(stats.in_work, 1);
  assert.equal(db.prepare('SELECT status s FROM leads').get().s, 'in_work');
});

test('СРМ поставила «отказ» — компания закрывается, команде записывается долг', () => {
  const db = setup();
  load(db, row());
  db.prepare("UPDATE leads SET status = 'assigned', assigned_team = 1").run();
  db.prepare('INSERT INTO assignments (lead_id, team_id) VALUES (1, 1)').run();

  const stats = load(db, row({ 6: 'Отказ' }));
  assert.equal(stats.declined, 1);
  assert.equal(db.prepare('SELECT status s FROM leads').get().s, 'rejected');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM queue_priority WHERE team_id = 1 AND consumed_at IS NULL").get().c, 1);
});

test('строка, помеченная фродом до первого импорта, в очередь не идёт', () => {
  const db = setup();
  load(db, row({ 6: 'Отказ' }));
  assert.equal(db.prepare('SELECT status s FROM leads').get().s, 'rejected');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM queue_priority').get().c, 0);
});

test('строка, уже помеченная в таблице, в очередь не попадает', () => {
  const db = setup();
  load(db, row({ 6: 'Назначено' }));
  assert.equal(db.prepare('SELECT status s FROM leads').get().s, 'assigned');
});

test('правка данных лидгеном обновляет компанию и пишется в журнал', () => {
  const db = setup();
  load(db, row());
  const stats = load(db, row({ 1: 'ООО Василёк' }));
  assert.equal(stats.updated, 1);
  assert.equal(db.prepare('SELECT company c FROM leads').get().c, 'ООО Василёк');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE kind = 'source_row_changed'").get());
});

test('строка без контактов и без типа уходит в карантин', () => {
  const db = setup();
  const stats = load(db, row({ 1: '', 2: '', 3: '', 5: '' }));
  assert.equal(stats.quarantined, 1);
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.match(lead.quarantine_reason, /нет телефона/);
  releaseFromQuarantine(db, lead.id);
  assert.equal(db.prepare('SELECT status s FROM leads').get().s, 'new');
});

test('та же компания от другого лидгена ловится как дубль', () => {
  const db = setup();
  load(db, row());
  const stats = load(db, row(), row({ 4: 'Бек' }));
  assert.equal(stats.duplicates, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'quarantine'").get().c, 1);
});

test('колонки вне схемы сохраняются в raw по своим буквам', () => {
  const db = setup();
  importBatch(db, toBatch([[...HEAD, 'Источник'], [...row(), 'Instagram']], CFG), CFG);
  assert.equal(JSON.parse(db.prepare('SELECT raw FROM leads').get().raw).H, 'Instagram');
});
