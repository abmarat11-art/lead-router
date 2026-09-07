import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import { importBatch, releaseFromQuarantine } from '../src/core/importer.js';
import { toBatch } from '../src/adapters/sheets.js';
import { normalizePhone, normalizeLang, normalizeOutcome, mapHeaders } from '../src/core/normalize.js';

const HEADERS = ['Дата', 'Компания', 'Контактное лицо', 'Телефон', 'Язык клиента', 'Лидогенератор', 'Итог работы', 'Регион'];
const row = (over = {}) => {
  const base = ['01.09.2026', 'ООО Ромашка', 'Иван', '+998 90 123 45 67', 'русский', 'Аня', 'Лид', 'Ташкент'];
  Object.entries(over).forEach(([i, v]) => { base[i] = v; });
  return base;
};

test('заголовки маппятся по синонимам', () => {
  const map = mapHeaders(HEADERS);
  assert.equal(map.company, 1);
  assert.equal(map.phone, 3);
  assert.equal(map.lang, 4);
  assert.equal(map.outcome_type, 6);
});

test('нормализация телефона, языка, итога', () => {
  assert.equal(normalizePhone('+998 90 123-45-67'), '+998901234567');
  assert.equal(normalizePhone('901234567'), '+998901234567');
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizeLang('Узбекский'), 'uz');
  assert.equal(normalizeLang('RU'), 'ru');
  assert.equal(normalizeOutcome('Назначена встреча'), 'meeting');
  assert.equal(normalizeOutcome('лид'), 'lead');
});

test('toBatch выкидывает пустые строки и нумерует с 2', () => {
  const batch = toBatch([HEADERS, row(), ['', '', '']], 'Лист1');
  assert.equal(batch.rows.length, 1);
  assert.equal(batch.rows[0].key, 'Лист1:2');
});

test('импорт создаёт лид и не дублирует при повторном проходе', () => {
  const db = openMigrated(':memory:');
  const batch = toBatch([HEADERS, row()], 'Лист1');
  assert.equal(importBatch(db, batch).created, 1);
  assert.deepEqual(importBatch(db, batch), { seen: 1, created: 0, updated: 0, skipped: 1, quarantined: 0, duplicates: 0 });
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.phone, '+998901234567');
  assert.equal(lead.lang, 'ru');
  assert.equal(lead.outcome_type, 'lead');
});

test('правка строки задним числом обновляет лид и пишется в журнал', () => {
  const db = openMigrated(':memory:');
  importBatch(db, toBatch([HEADERS, row()], 'Лист1'));
  const stats = importBatch(db, toBatch([HEADERS, row({ 1: 'ООО Василёк' })], 'Лист1'));
  assert.equal(stats.updated, 1);
  assert.equal(db.prepare('SELECT company c FROM leads').get().c, 'ООО Василёк');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE kind = 'source_row_changed'").get());
});

test('строка без контактов уходит в карантин, а не в распределение', () => {
  const db = openMigrated(':memory:');
  const stats = importBatch(db, toBatch([HEADERS, row({ 3: '', 1: '', 2: '' })], 'Лист1'));
  assert.equal(stats.quarantined, 1);
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.status, 'quarantine');
  assert.match(lead.quarantine_reason, /нет телефона/);
  releaseFromQuarantine(db, lead.id);
  assert.equal(db.prepare('SELECT status s FROM leads').get().s, 'new');
});

test('тот же клиент от другого лидгена ловится как дубль', () => {
  const db = openMigrated(':memory:');
  importBatch(db, toBatch([HEADERS, row()], 'Лист1'));
  const stats = importBatch(db, toBatch([HEADERS, row(), row({ 5: 'Бек' })], 'Лист1'));
  assert.equal(stats.duplicates, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'quarantine'").get().c, 1);
});

test('неизвестные колонки сохраняются в raw', () => {
  const db = openMigrated(':memory:');
  importBatch(db, toBatch([[...HEADERS, 'Источник'], [...row(), 'Instagram']], 'Лист1'));
  assert.equal(JSON.parse(db.prepare('SELECT raw FROM leads').get().raw)['Источник'], 'Instagram');
});
