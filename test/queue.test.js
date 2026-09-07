import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import { setConfig, DEFAULT_CONFIG } from '../src/core/columns.js';
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

test('фрод даёт команде долг: 1,2,3 → фрод у 1 → 1,4,1,2,3', () => {
  const db = setup();
  const first = addLead(db);                 // команда 1
  assignNext(db, first);
  assign(db);                                // 2
  assign(db);                                // 3

  markDeclined(db, first, 'фрод');           // ход команды 1 ушёл впустую

  // компания закрыта и никому больше не идёт
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(first);
  assert.equal(lead.status, 'rejected');
  assert.equal(lead.assigned_team, 1, 'в истории остаётся, кому её выдали');

  // долг гасится следующей компанией, дальше обычный круг с места остановки
  assert.deepEqual(Array.from({ length: 5 }, () => assign(db)), [1, 4, 1, 2, 3]);
});

test('несколько долгов гасятся в порядке поступления', () => {
  const db = setup();
  const a = addLead(db); assignNext(db, a);  // 1
  const b = addLead(db); assignNext(db, b);  // 2
  markDeclined(db, b, 'фрод');               // долг: 2
  markDeclined(db, a, 'фрод');               // долг: 2, затем 1
  assert.deepEqual(Array.from({ length: 5 }, () => assign(db)), [2, 1, 3, 4, 1]);
});

test('долг привязан к своей очереди: фрод по лиду не двигает встречи', () => {
  const db = setup();
  const id = addLead(db, 'lead'); assignNext(db, id);   // лиды: команда 1
  markDeclined(db, id, 'фрод');
  assert.equal(assign(db, 'meeting'), 1, 'очередь встреч идёт своим кругом');
  assert.equal(assign(db, 'lead'), 1, 'долг гасится в очереди лидов');
});

test('«в работе» из таблицы закрывает назначение', () => {
  const db = setup();
  const id = addLead(db);
  assignNext(db, id);
  markInWork(db, id);
  assert.equal(db.prepare('SELECT status s FROM leads WHERE id = ?').get(id).s, 'in_work');
  assert.equal(db.prepare('SELECT state s FROM assignments WHERE lead_id = ?').get(id).s, 'in_work');
});

test('фрод закрывает компанию: повторно она не раздаётся', () => {
  const db = setup(2);
  const id = addLead(db);
  assignNext(db, id);                                  // команда 1
  markDeclined(db, id, 'фрод от лидгена');
  assert.equal(db.prepare('SELECT status s FROM leads WHERE id = ?').get(id).s, 'rejected');
  assert.equal(assignNext(db, id), null, 'закрытую компанию заново не раздаём');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assignments WHERE lead_id = ?').get(id).c, 1);
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

test('погашение долга ставит галочку напротив фродовой строки', () => {
  process.env.SHEETS_SPREADSHEET_ID = 'sheet-id';
  setConfig({ ...DEFAULT_CONFIG, columns: { ...DEFAULT_CONFIG.columns, debt_closed: 'H' } });
  try {
    const db = setup();
    const fraud = addLead(db);
    assignNext(db, fraud);                        // команда 1
    markDeclined(db, fraud, 'фрод');              // долг команде 1
    db.prepare('DELETE FROM sheet_writes').run(); // очищаем пометки «назначено»

    const next = addLead(db);
    assignNext(db, next);                         // гасим долг: снова команда 1

    const writes = db.prepare('SELECT * FROM sheet_writes ORDER BY id').all();
    const debtWrite = writes.find((w) => w.column_ref === 'H');
    assert.ok(debtWrite, 'галочка «долг закрыт» поставлена');
    assert.equal(debtWrite.lead_id, fraud, 'галочка идёт в строку фрода, а не новой компании');
    assert.equal(debtWrite.value, 'TRUE');
    assert.equal(
      db.prepare('SELECT closed_lead_id c FROM queue_priority').get().c, next,
      'в журнале видно, какой компанией закрыт долг'
    );
  } finally {
    delete process.env.SHEETS_SPREADSHEET_ID;
    setConfig(DEFAULT_CONFIG);
  }
});

test('без колонки чекбокса галочка просто не пишется', () => {
  process.env.SHEETS_SPREADSHEET_ID = 'sheet-id';
  try {
    const db = setup();
    const fraud = addLead(db);
    assignNext(db, fraud);
    markDeclined(db, fraud, 'фрод');
    db.prepare('DELETE FROM sheet_writes').run();
    assignNext(db, addLead(db));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sheet_writes WHERE column_ref != 'G'").get().c, 0);
  } finally {
    delete process.env.SHEETS_SPREADSHEET_ID;
  }
});

test('превью очереди показывает долги', () => {
  const db = setup();
  const id = addLead(db); assignNext(db, id);
  markDeclined(db, id, 'фрод');
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
