import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import {
  assignNext, dispatchQueue, markInWork, markDeclined, assignManually,
  queuePreview, escalate,
} from '../src/core/queue.js';

function setup(teams = 4) {
  const db = openMigrated(':memory:');
  const add = db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (?, ?, ?)');
  for (let i = 1; i <= teams; i++) add.run(i, `Команда ${i}`, i);
  return db;
}

let seq = 0;
function addLead(db, kind = 'lead') {
  const key = `Лист1:${++seq + 1}`;
  const info = db.prepare(
    'INSERT INTO leads (source_key, source_hash, company, kind) VALUES (?, ?, ?, ?)'
  ).run(key, `h${seq}`, `Компания ${seq}`, kind);
  return Number(info.lastInsertRowid);
}

const assign = (db, kind = 'lead') => assignNext(db, addLead(db, kind)).team_id;

test('по умолчанию идёт круг 1,2,3,4,1,2', () => {
  const db = setup();
  const got = Array.from({ length: 6 }, () => assign(db));
  assert.deepEqual(got, [1, 2, 3, 4, 1, 2]);
});

test('лиды и встречи — независимые очереди', () => {
  const db = setup();
  assert.equal(assign(db, 'lead'), 1);
  assert.equal(assign(db, 'meeting'), 1);   // своя очередь, свой курсор
  assert.equal(assign(db, 'lead'), 2);
  assert.equal(assign(db, 'meeting'), 2);
  assert.equal(assign(db, 'meeting'), 3);
  assert.equal(assign(db, 'lead'), 3);
});

test('отказ ставит команду вне очереди: 1,2,3 → отказ от 1 → 1,4,1,2,3,4', () => {
  const db = setup();
  const first = addLead(db);                 // команда 1
  assignNext(db, first);
  assign(db);                                // 2
  assign(db);                                // 3

  markDeclined(db, first, 'отказ из СРМ');   // команда 1 встаёт вне очереди

  // сама отказанная компания уходит дальше по кругу, мимо отказавшей команды
  assert.equal(db.prepare('SELECT assigned_team t FROM leads WHERE id = ?').get(first).t, 4);

  // а внеочередной приоритет команды 1 достаётся следующей новой компании
  const got = Array.from({ length: 5 }, () => assign(db));
  assert.deepEqual(got, [1, 4, 1, 2, 3]);
});

test('внеочередник достаётся и возвращённой компании, если она ему подходит', () => {
  const db = setup();
  const a = addLead(db); assignNext(db, a);  // 1
  const b = addLead(db); assignNext(db, b);  // 2
  markDeclined(db, b, 'отказ');              // приоритет: 2; сама компания b уходит к 3
  assert.equal(db.prepare('SELECT assigned_team t FROM leads WHERE id = ?').get(b).t, 3);
  markDeclined(db, a, 'отказ');              // приоритет: 2 и 1; компания a достаётся внеочередной 2
  assert.equal(db.prepare('SELECT assigned_team t FROM leads WHERE id = ?').get(a).t, 2);
  // остался внеочередник 1, дальше круг продолжается с места остановки
  assert.deepEqual(Array.from({ length: 4 }, () => assign(db)), [1, 3, 4, 1]);
});

test('«в работе» из таблицы закрывает назначение', () => {
  const db = setup();
  const id = addLead(db);
  assignNext(db, id);
  markInWork(db, id);
  assert.equal(db.prepare('SELECT status s FROM leads WHERE id = ?').get(id).s, 'in_work');
  assert.equal(db.prepare('SELECT state s FROM assignments WHERE lead_id = ?').get(id).s, 'in_work');
});

test('отказ переназначает компанию и не возвращает её отказавшей команде', () => {
  const db = setup(2);
  const id = addLead(db);
  assignNext(db, id);                                  // команда 1
  markDeclined(db, id, 'не наш профиль');
  assert.equal(db.prepare('SELECT assigned_team t FROM leads WHERE id = ?').get(id).t, 2);
  markDeclined(db, id, 'тоже мимо');
  // обе команды отказались — компания на стол руководителю, а не по кругу
  assert.equal(db.prepare('SELECT status s FROM leads WHERE id = ?').get(id).s, 'escalated');
});

test('неактивная команда выпадает из круга', () => {
  const db = setup();
  db.prepare('UPDATE teams SET active = 0 WHERE id = 2').run();
  assert.deepEqual(Array.from({ length: 4 }, () => assign(db)), [1, 3, 4, 1]);
});

test('нет активных команд — эскалация', () => {
  const db = setup();
  db.prepare('UPDATE teams SET active = 0').run();
  const id = addLead(db);
  assert.equal(assignNext(db, id), null);
  assert.equal(db.prepare('SELECT status s FROM leads WHERE id = ?').get(id).s, 'escalated');
});

test('ручное назначение отменяет текущее и не двигает круг', () => {
  const db = setup();
  const id = addLead(db);
  assignNext(db, id);                        // команда 1
  assignManually(db, id, 4);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM assignments WHERE lead_id = ? AND state = 'cancelled'").get(id).c, 1);
  assert.equal(db.prepare('SELECT assigned_team t FROM leads WHERE id = ?').get(id).t, 4);
  assert.equal(assign(db), 2);               // круг продолжается с того места, где встал
});

test('dispatchQueue разбирает пул по обеим очередям', () => {
  const db = setup();
  addLead(db, 'lead'); addLead(db, 'lead'); addLead(db, 'meeting');
  assert.deepEqual(dispatchQueue(db), { seen: 3, assigned: 3 });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'assigned'").get().c, 3);
});

test('превью очереди показывает внеочередников', () => {
  const db = setup();
  const id = addLead(db); assignNext(db, id);
  markDeclined(db, id, 'отказ');
  const preview = queuePreview(db, 'lead', 4).map((p) => p.team_id);
  assert.equal(preview[0], 1);
  assert.equal(queuePreview(db, 'lead', 4)[0].via_priority, true);
});

test('эскалация вручную снимает назначение', () => {
  const db = setup();
  const id = addLead(db);
  assignNext(db, id);
  escalate(db, id, 'кривой лид');
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  assert.equal(lead.status, 'escalated');
  assert.equal(lead.assigned_team, null);
});
