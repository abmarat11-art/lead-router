import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import {
  addMember, updateMember, removeMember, listMembers, teamHistory,
  assigneeOf, notifyListOf, renameTeam,
} from '../src/core/teams.js';
import { deliverPending } from '../src/core/argusDelivery.js';
import { assignNext } from '../src/core/queue.js';

function setup() {
  const db = openMigrated(':memory:');
  db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (1, ?, 1)').run('Команда 1');
  db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (2, ?, 2)').run('Команда 2');
  return db;
}

const addLead = (db, kind = 'lead') => Number(db.prepare(
  'INSERT INTO leads (source_key, source_hash, company, kind) VALUES (?, ?, ?, ?)'
).run(`Лист1:${Math.random()}`, 'h', 'ООО Ромашка', kind).lastInsertRowid);

test('в команде несколько человек: один получает, остальные уведомляются', () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'u-1', name: 'Аня', role: 'assignee' });
  addMember(db, 1, { argus_user_id: 'u-2', name: 'Бек' });
  addMember(db, 1, { argus_user_id: 'u-3', name: 'Вика' });

  assert.equal(assigneeOf(db, 1), 'u-1');
  assert.deepEqual(notifyListOf(db, 1), ['u-2', 'u-3']);
  assert.equal(listMembers(db, 1).length, 3);
});

test('получатель в команде один: назначение нового снимает роль со старого', () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'u-1', role: 'assignee' });
  const second = addMember(db, 1, { argus_user_id: 'u-2' });

  updateMember(db, 1, second, { role: 'assignee' });

  assert.equal(assigneeOf(db, 1), 'u-2');
  assert.deepEqual(notifyListOf(db, 1), ['u-1'], 'прежний получатель остаётся на уведомлениях');
});

test('назначение уходит на получателя команды, а не на кого попало', async () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'u-notify' });
  addMember(db, 1, { argus_user_id: 'u-main', role: 'assignee' });

  const id = addLead(db);
  assignNext(db, id);

  const calls = [];
  await deliverPending(db, {
    ensure: async (company, placement) => { calls.push(placement); return { id: 'c-1', created: true }; },
  });
  assert.equal(calls[0].assignedById, 'u-main');
});

test('выключенный участник получателем не считается', async () => {
  const db = setup();
  const main = addMember(db, 1, { argus_user_id: 'u-main', role: 'assignee' });
  updateMember(db, 1, main, { active: 0 });

  assert.equal(assigneeOf(db, 1), null);

  const id = addLead(db);
  assignNext(db, id);
  const res = await deliverPending(db, { ensure: async () => { throw new Error('не должно вызываться'); } });
  assert.equal(res.failed, 1);
  assert.match(db.prepare('SELECT argus_error e FROM leads WHERE id = ?').get(id).e, /не выбран получатель/);
});

test('каждая правка состава попадает в журнал команды', () => {
  const db = setup();
  const first = addMember(db, 1, { argus_user_id: 'u-1', role: 'assignee' });
  const second = addMember(db, 1, { argus_user_id: 'u-2' });
  updateMember(db, 1, second, { role: 'assignee' });
  removeMember(db, 1, first);

  const kinds = teamHistory(db, 1).map((h) => h.kind);
  assert.deepEqual(kinds, ['member_removed', 'member_changed', 'assignee_replaced', 'member_added', 'member_added']);

  const replaced = teamHistory(db, 1).find((h) => h.kind === 'assignee_replaced');
  assert.equal(JSON.parse(replaced.data).was, 'u-1', 'видно, у кого забрали назначение');
});

test('журнал команды не смешивается с чужим', () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'u-1' });
  addMember(db, 2, { argus_user_id: 'u-9' });
  assert.equal(teamHistory(db, 1).length, 1);
  assert.equal(teamHistory(db, 2).length, 1);
});

test('участник без id в Аргусе не заводится', () => {
  const db = setup();
  assert.throws(() => addMember(db, 1, { name: 'Без id' }), /нужен id пользователя/);
});

test('назначение и смена статуса проставляют отметки времени', () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'u-1', role: 'assignee' });
  const id = addLead(db);
  assignNext(db, id);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  assert.ok(lead.assigned_at, 'записано время назначения');
  assert.ok(lead.status_changed_at, 'записано время смены статуса');
});

test('вписали получателя — упавшие компании возвращаются в очередь доставки', () => {
  const db = setup();
  const id = addLead(db);
  db.prepare(`UPDATE leads SET assigned_team = 1, argus_state = 'failed', argus_attempts = 5,
              argus_error = 'у команды «Команда 1» не выбран получатель назначения' WHERE id = ?`).run(id);

  addMember(db, 1, { argus_user_id: 'uuid-1', name: 'Ойбек', role: 'assignee' });

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  assert.equal(lead.argus_state, 'pending', 'иначе компания навсегда останется незаведённой');
  assert.equal(lead.argus_attempts, 0);
  assert.equal(lead.argus_error, null);
});

test('пустое имя команды не сохраняем: в очередях останется безымянная строка', () => {
  const db = setup();
  assert.throws(() => renameTeam(db, 1, { name: '  ' }), /название/);
  assert.equal(db.prepare('SELECT name FROM teams WHERE id = 1').get().name, 'Команда 1');
});

test('переименование пишется в журнал команды', () => {
  const db = setup();
  renameTeam(db, 1, { name: 'Альфа', queue_order: 2 });
  const team = db.prepare('SELECT * FROM teams WHERE id = 1').get();
  assert.equal(team.name, 'Альфа');
  assert.equal(team.queue_order, 2);
  const last = teamHistory(db, 1)[0];
  assert.equal(last.kind, 'team_changed');
  assert.match(last.data, /Альфа/);
});
