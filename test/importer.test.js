import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import { importBatch, releaseFromQuarantine } from '../src/core/importer.js';
import { toBatch } from '../src/adapters/sheets.js';
import { normalizePhone, normalizeKind, normalizeStatus, mapHeaders } from '../src/core/normalize.js';

const HEADERS = ['Дата', 'Компания', 'Контактное лицо', 'Телефон', 'Лидогенератор', 'Тип лида', 'Статус'];
const row = (over = {}) => {
  const base = ['01.09.2026', 'ООО Ромашка', 'Иван', '+998 90 123 45 67', 'Аня', 'Лид', ''];
  Object.entries(over).forEach(([i, v]) => { base[i] = v; });
  return base;
};

function setup(teams = 4) {
  const db = openMigrated(':memory:');
  const add = db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (?, ?, ?)');
  for (let i = 1; i <= teams; i++) add.run(i, `Команда ${i}`, i);
  return db;
}

test('заголовки маппятся по синонимам', () => {
  const map = mapHeaders(HEADERS);
  assert.equal(map.company, 1);
  assert.equal(map.phone, 3);
  assert.equal(map.lead_type, 5);
  assert.equal(map.status, 6);
});

test('нормализация телефона, вида и статуса', () => {
  assert.equal(normalizePhone('+998 90 123-45-67'), '+998901234567');
  assert.equal(normalizePhone('901234567'), '+998901234567');
  assert.equal(normalizeKind('Назначена встреча'), 'meeting');
  assert.equal(normalizeKind('лид'), 'lead');
  assert.equal(normalizeStatus(''), null);
  assert.equal(normalizeStatus('Отказ'), 'declined');
  assert.equal(normalizeStatus('в работе'), 'in_work');
  assert.equal(normalizeStatus('Назначено'), 'assigned');
});

test('toBatch выкидывает пустые строки и нумерует с 2', () => {
  const batch = toBatch([HEADERS, row(), ['', '', '']], 'Лист1');
  assert.equal(batch.rows.length, 1);
  assert.equal(batch.rows[0].key, 'Лист1:2');
});

test('строка с пустым статусом становится новой компанией в пуле', () => {
  const db = setup();
  const batch = toBatch([HEADERS, row()], 'Лист1');
  assert.equal(importBatch(db, batch).created, 1);
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.status, 'new');
  assert.equal(lead.kind, 'lead');
  assert.equal(lead.phone, '+998901234567');
});

test('повторный проход по неизменной строке ничего не делает', () => {
  const db = setup();
  const batch = toBatch([HEADERS, row()], 'Лист1');
  importBatch(db, batch);
  assert.equal(importBatch(db, batch).skipped, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM leads').get().c, 1);
});

test('СРМ поставила «в работе» — контур это подхватывает', () => {
  const db = setup();
  importBatch(db, toBatch([HEADERS, row()], 'Лист1'));
  db.prepare("UPDATE leads SET status = 'assigned', assigned_team = 1").run();
  db.prepare('INSERT INTO assignments (lead_id, team_id) VALUES (1, 1)').run();

  const stats = importBatch(db, toBatch([HEADERS, row({ 6: 'В работе' })], 'Лист1'));
  assert.equal(stats.in_work, 1);
  assert.equal(db.prepare('SELECT status s FROM leads').get().s, 'in_work');
});

test('СРМ поставила «отказ» — компания уходит следующей команде, отказавшая встаёт вне очереди', () => {
  const db = setup();
  importBatch(db, toBatch([HEADERS, row()], 'Лист1'));
  db.prepare("UPDATE leads SET status = 'assigned', assigned_team = 1").run();
  db.prepare('INSERT INTO assignments (lead_id, team_id) VALUES (1, 1)').run();

  const stats = importBatch(db, toBatch([HEADERS, row({ 6: 'Отказ' })], 'Лист1'));
  assert.equal(stats.declined, 1);
  assert.equal(db.prepare('SELECT assigned_team t FROM leads').get().t, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM queue_priority WHERE team_id = 1 AND consumed_at IS NULL").get().c, 1);
});

test('строка, уже помеченная в таблице, в очередь не попадает', () => {
  const db = setup();
  importBatch(db, toBatch([HEADERS, row({ 6: 'Назначено' })], 'Лист1'));
  assert.equal(db.prepare('SELECT status s FROM leads').get().s, 'assigned');
});

test('правка данных лидгеном обновляет компанию и пишется в журнал', () => {
  const db = setup();
  importBatch(db, toBatch([HEADERS, row()], 'Лист1'));
  const stats = importBatch(db, toBatch([HEADERS, row({ 1: 'ООО Василёк' })], 'Лист1'));
  assert.equal(stats.updated, 1);
  assert.equal(db.prepare('SELECT company c FROM leads').get().c, 'ООО Василёк');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE kind = 'source_row_changed'").get());
});

test('строка без контактов и без типа уходит в карантин', () => {
  const db = setup();
  const stats = importBatch(db, toBatch([HEADERS, row({ 1: '', 2: '', 3: '', 5: '' })], 'Лист1'));
  assert.equal(stats.quarantined, 1);
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.match(lead.quarantine_reason, /нет телефона/);
  releaseFromQuarantine(db, lead.id);
  assert.equal(db.prepare('SELECT status s FROM leads').get().s, 'new');
});

test('та же компания от другого лидгена ловится как дубль', () => {
  const db = setup();
  importBatch(db, toBatch([HEADERS, row()], 'Лист1'));
  const stats = importBatch(db, toBatch([HEADERS, row(), row({ 4: 'Бек' })], 'Лист1'));
  assert.equal(stats.duplicates, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'quarantine'").get().c, 1);
});

test('неизвестные колонки сохраняются в raw', () => {
  const db = setup();
  importBatch(db, toBatch([[...HEADERS, 'Источник'], [...row(), 'Instagram']], 'Лист1'));
  assert.equal(JSON.parse(db.prepare('SELECT raw FROM leads').get().raw)['Источник'], 'Instagram');
});
