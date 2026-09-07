import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import {
  offerLead, acceptOffer, declineOffer, expireOffers, dispatchQueue,
  eligibleEmployees, escalate, assignManually, MAX_DECLINES,
} from '../src/core/router.js';

function setup({ strategy = 'round_robin' } = {}) {
  const db = openMigrated(':memory:');
  db.prepare('INSERT INTO teams (id, name, strategy) VALUES (1, ?, ?)').run('Команда А', strategy);
  const add = db.prepare('INSERT INTO employees (id, team_id, name, langs, queue_order, daily_limit) VALUES (?, 1, ?, ?, ?, ?)');
  add.run(1, 'Аня', '["ru"]', 1, 0);
  add.run(2, 'Бек', '["ru","uz"]', 2, 0);
  add.run(3, 'Вика', '["uz"]', 3, 0);
  return db;
}

function addLead(db, { lang = 'ru', team = 1, key = 'row-1' } = {}) {
  const info = db.prepare(
    'INSERT INTO leads (source_key, source_hash, company, lang, team_id, outcome_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(key, 'h', 'ООО Тест', lang, team, 'lead');
  return Number(info.lastInsertRowid);
}

test('язык клиента фильтрует получателей', () => {
  const db = setup();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?');
  const id = addLead(db, { lang: 'uz' });
  const names = eligibleEmployees(db, lead.get(id)).map((e) => e.name);
  assert.deepEqual(names, ['Бек', 'Вика']);
});

test('дневной лимит выводит сотрудника из выдачи', () => {
  const db = setup();
  db.prepare('UPDATE employees SET daily_limit = 1 WHERE id = 1').run();
  const id = addLead(db);
  acceptOffer(db, offerLead(db, id).id);
  const next = addLead(db, { key: 'row-2' });
  const names = eligibleEmployees(db, db.prepare('SELECT * FROM leads WHERE id = ?').get(next)).map((e) => e.name);
  assert.ok(!names.includes('Аня'));
});

test('round-robin идёт по кругу', () => {
  const db = setup();
  const got = [];
  for (let i = 0; i < 4; i++) {
    const id = addLead(db, { key: `row-${i}`, lang: null });
    got.push(offerLead(db, id).employee_id);
  }
  assert.deepEqual(got, [1, 2, 3, 1]);
});

test('balance отдаёт наименее загруженному', () => {
  const db = setup({ strategy: 'balance' });
  const a = addLead(db, { key: 'a' });
  acceptOffer(db, offerLead(db, a).id);      // Аня взяла один
  const b = addLead(db, { key: 'b' });
  assert.notEqual(offerLead(db, b).employee_id, 1);
});

test('принятие закрепляет лид за сотрудником', () => {
  const db = setup();
  const id = addLead(db);
  const offer = offerLead(db, id);
  assert.equal(acceptOffer(db, offer.id).ok, true);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  assert.equal(lead.status, 'assigned');
  assert.equal(lead.assigned_to, offer.employee_id);
  assert.equal(acceptOffer(db, offer.id).ok, false, 'повторный акцепт не проходит');
});

test('отказ уводит лид следующему и не возвращает отказавшемуся', () => {
  const db = setup();
  const id = addLead(db);
  const first = offerLead(db, id);
  declineOffer(db, first.id, 'не мой регион');
  const second = db.prepare("SELECT * FROM offers WHERE lead_id = ? AND state = 'pending'").get(id);
  assert.notEqual(second.employee_id, first.employee_id);
  assert.equal(db.prepare('SELECT decline_count c FROM leads WHERE id = ?').get(id).c, 1);
});

test('после MAX_DECLINES отказов лид уходит в эскалацию', () => {
  const db = setup();
  const id = addLead(db, { lang: null });
  for (let i = 0; i < MAX_DECLINES; i++) {
    const offer = db.prepare("SELECT * FROM offers WHERE lead_id = ? AND state = 'pending'").get(id)
      || offerLead(db, id);
    declineOffer(db, offer.id, 'занят');
  }
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(id).status, 'escalated');
});

test('протухшее предложение переходит следующему', () => {
  const db = setup();
  const id = addLead(db);
  const offer = offerLead(db, id);
  db.prepare("UPDATE offers SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(offer.id);
  assert.equal(expireOffers(db), 1);
  assert.equal(db.prepare('SELECT state FROM offers WHERE id = ?').get(offer.id).state, 'expired');
  const next = db.prepare("SELECT * FROM offers WHERE lead_id = ? AND state = 'pending'").get(id);
  assert.notEqual(next.employee_id, offer.employee_id);
});

test('некому отдать — сразу эскалация', () => {
  const db = setup();
  db.prepare('UPDATE employees SET active = 0').run();
  const id = addLead(db);
  assert.equal(offerLead(db, id), null);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(id).status, 'escalated');
});

test('ручное назначение отменяет висящее предложение', () => {
  const db = setup();
  const id = addLead(db);
  const offer = offerLead(db, id);
  assignManually(db, id, 3);
  assert.equal(db.prepare('SELECT state FROM offers WHERE id = ?').get(offer.id).state, 'cancelled');
  assert.equal(db.prepare('SELECT assigned_to a FROM leads WHERE id = ?').get(id).a, 3);
});

test('dispatchQueue разбирает пул', () => {
  const db = setup();
  for (let i = 0; i < 3; i++) addLead(db, { key: `q-${i}` });
  assert.deepEqual(dispatchQueue(db), { seen: 3, offered: 3 });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM offers WHERE state = 'pending'").get().c, 3);
});

test('эскалация пишется в журнал событий', () => {
  const db = setup();
  const id = addLead(db);
  escalate(db, id, 'тест');
  const ev = db.prepare("SELECT * FROM events WHERE lead_id = ? AND kind = 'escalated'").get(id);
  assert.equal(JSON.parse(ev.data).reason, 'тест');
});
