import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnIndex, columnLetter, resolveConfig, DEFAULT_CONFIG } from '../src/core/columns.js';
import { normalizeRow, normalizeStatus, normalizeKind } from '../src/core/normalize.js';
import { toBatch } from '../src/adapters/sheets.js';

const cfg = resolveConfig(DEFAULT_CONFIG);

test('буквы и номера колонок переводятся в индексы', () => {
  assert.equal(columnIndex('A'), 0);
  assert.equal(columnIndex('c'), 2);
  assert.equal(columnIndex('AA'), 26);
  assert.equal(columnIndex(3), 2);
  assert.equal(columnIndex('3'), 2);
  assert.equal(columnIndex(null), null);
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(26), 'AA');
  assert.throws(() => columnIndex('A1'), /не понимаю колонку/);
  assert.throws(() => columnIndex(0), /целым от 1/);
});

test('конфиг ругается на пропущенные обязательные колонки', () => {
  assert.throws(
    () => resolveConfig({ columns: { company: 'B', phone: 'D' } }),
    /не заданы обязательные колонки: lead_type, status/
  );
});

test('конфиг ругается на одну колонку в двух полях', () => {
  assert.throws(
    () => resolveConfig({ columns: { company: 'B', phone: 'B', lead_type: 'F', status: 'G' } }),
    /колонка B указана дважды/
  );
});

test('строка читается строго по индексам колонок', () => {
  const cells = ['01.09.2026', 'ООО Ромашка', 'Иван', '901234567', 'Лидген-1', 'Лид', ''];
  const { lead, problems } = normalizeRow(cells, cfg);
  assert.deepEqual(problems, []);
  assert.equal(lead.company, 'ООО Ромашка');
  assert.equal(lead.contact_name, 'Иван');
  assert.equal(lead.phone, '+998901234567');
  assert.equal(lead.lead_gen, 'Лидген-1');
  assert.equal(lead.kind, 'lead');
  assert.equal(lead.source_status, null);
  assert.equal(lead.raw.B, 'ООО Ромашка', 'сырые ячейки хранятся по буквам колонок');
});

test('другая раскладка колонок читается тем же кодом', () => {
  const custom = resolveConfig({
    sheet: 'Лиды',
    columns: { company: 1, phone: 2, lead_type: 3, status: 4, lead_gen: 5 },
  });
  const { lead } = normalizeRow(['Chinor', '+998901112233', 'Встреча', '', 'Бек'], custom);
  assert.equal(lead.company, 'Chinor');
  assert.equal(lead.kind, 'meeting');
  assert.equal(lead.lead_gen, 'Бек');
  assert.equal(custom.statusColumn, 'D');
});

test('тип лида сверяется с настроенными значениями, а не угадывается', () => {
  assert.equal(normalizeKind('Лид', cfg), 'lead');
  assert.equal(normalizeKind('  встреча ', cfg), 'meeting');
  assert.equal(normalizeKind('назначена встреча', cfg), null, 'не совпало — не выдумываем');
});

test('статус сверяется с настроенными значениями', () => {
  assert.equal(normalizeStatus('', cfg), null);
  assert.equal(normalizeStatus('Назначено', cfg), 'assigned');
  assert.equal(normalizeStatus('В работе', cfg), 'in_work');
  assert.equal(normalizeStatus('отказ', cfg), 'declined');
  assert.equal(normalizeStatus('перезвонить завтра', cfg), 'other');
});

test('незнакомый тип лида отправляет строку в карантин с внятной причиной', () => {
  const { problems } = normalizeRow(['', 'ООО Ромашка', '', '901234567', '', 'фигня', ''], cfg);
  assert.deepEqual(problems, ['тип лида "фигня" не совпал ни с одним из настроенных']);
});

test('toBatch нумерует строки по номеру в таблице и пропускает шапку', () => {
  const values = [
    ['Дата', 'Компания', 'Контакт', 'Телефон', 'Лидген', 'Тип', 'Статус'],
    ['01.09', 'ООО Ромашка', 'Иван', '901234567', 'Аня', 'Лид', ''],
    ['', '', '', '', '', '', ''],
    ['02.09', 'Chinor', 'Азиз', '901234568', 'Аня', 'Встреча', ''],
  ];
  const batch = toBatch(values, cfg);
  assert.deepEqual(batch.rows.map((r) => r.key), ['Лист1:2', 'Лист1:4']);
});
