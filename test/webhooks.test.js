import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openMigrated } from '../src/db/index.js';
import { enqueueWebhook, flushOutbox } from '../src/core/webhooks.js';
import { assignNext, markDeclined, markInWork } from '../src/core/queue.js';
import { flushSheetWrites } from '../src/core/sheetWriter.js';

function setup() {
  const db = openMigrated(':memory:');
  db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (1, ?, 1)').run('Команда 1');
  db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (2, ?, 2)').run('Команда 2');
  db.prepare('INSERT INTO leads (id, source_key, source_hash, company, kind) VALUES (1, ?, ?, ?, ?)')
    .run('Лист1:2', 'h', 'ООО Ромашка', 'lead');
  return db;
}

beforeEach(() => {
  process.env.ARGUS_WEBHOOK_URL = 'https://argus.example/hook';
  process.env.ARGUS_WEBHOOK_SECRET = 'secret';
  delete process.env.SHEETS_STATUS_COLUMN;
});

test('без настроенного URL вебхуки не копятся', () => {
  delete process.env.ARGUS_WEBHOOK_URL;
  const db = setup();
  assert.equal(enqueueWebhook(db, 'lead.assigned', 1, 1), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM webhook_outbox').get().c, 0);
});

test('назначение кладёт lead.assigned с компанией и командой', () => {
  const db = setup();
  assignNext(db, 1);
  const row = db.prepare('SELECT * FROM webhook_outbox').get();
  assert.equal(row.event, 'lead.assigned');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.lead.company, 'ООО Ромашка');
  assert.equal(payload.lead.source_key, 'Лист1:2');
  assert.equal(payload.lead.kind, 'lead');
  assert.equal(payload.team.name, 'Команда 1');
});

test('фрод шлёт lead.declined и на этом цикл компании закрыт', () => {
  const db = setup();
  assignNext(db, 1);
  markDeclined(db, 1, 'фрод от лидгена');
  const events = db.prepare('SELECT event FROM webhook_outbox ORDER BY id').all().map((r) => r.event);
  assert.deepEqual(events, ['lead.assigned', 'lead.declined']);
  const payload = JSON.parse(db.prepare("SELECT payload FROM webhook_outbox WHERE event = 'lead.declined'").get().payload);
  assert.equal(payload.reason, 'фрод от лидгена');
  assert.equal(payload.team.name, 'Команда 1');
});

test('«в работе» уходит в СРМ отдельным событием', () => {
  const db = setup();
  assignNext(db, 1);
  markInWork(db, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM webhook_outbox WHERE event = 'lead.in_work'").get().c, 1);
});

test('успешная отправка подписывает тело и помечает sent', async () => {
  const db = setup();
  enqueueWebhook(db, 'lead.assigned', 1, 1);
  const seen = [];
  const res = await flushOutbox(db, {
    fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200 }; },
  });
  assert.deepEqual(res, { picked: 1, sent: 1, failed: 0 });
  const expected = createHmac('sha256', 'secret').update(seen[0].init.body).digest('hex');
  assert.equal(seen[0].init.headers['x-lead-router-signature'], expected);
  assert.equal(db.prepare('SELECT state s FROM webhook_outbox').get().s, 'sent');
});

test('ошибка СРМ оставляет задачу в очереди с ретраем', async () => {
  const db = setup();
  enqueueWebhook(db, 'lead.assigned', 1, 1);
  await flushOutbox(db, { fetchImpl: async () => ({ ok: false, status: 502 }) });
  const row = db.prepare('SELECT * FROM webhook_outbox').get();
  assert.equal(row.state, 'pending');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /502/);
});

test('после исчерпания попыток задача помечается failed', async () => {
  const db = setup();
  enqueueWebhook(db, 'lead.assigned', 1, 1);
  const fail = { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } };
  for (let i = 0; i < 5; i++) {
    db.prepare("UPDATE webhook_outbox SET next_attempt_at = datetime('now', '-1 hour')").run();
    await flushOutbox(db, fail);
  }
  assert.equal(db.prepare('SELECT state s FROM webhook_outbox').get().s, 'failed');
});

test('назначение ставит пометку в таблицу напротив компании', async () => {
  process.env.SHEETS_STATUS_COLUMN = 'H';
  const db = setup();
  assignNext(db, 1);
  const pending = db.prepare('SELECT * FROM sheet_writes').get();
  assert.equal(pending.source_key, 'Лист1:2');
  assert.equal(pending.value, 'назначено');

  const written = [];
  const res = await flushSheetWrites(db, { write: async (w) => { written.push(w); } });
  assert.deepEqual(res, { picked: 1, written: 1, failed: 0 });
  assert.deepEqual(written[0], { sourceKey: 'Лист1:2', value: 'назначено' });
  assert.equal(db.prepare('SELECT state s FROM sheet_writes').get().s, 'written');
});

test('сбой записи в таблицу не теряет пометку', async () => {
  process.env.SHEETS_STATUS_COLUMN = 'H';
  const db = setup();
  assignNext(db, 1);
  const res = await flushSheetWrites(db, { write: async () => { throw new Error('quota'); } });
  assert.equal(res.failed, 1);
  const row = db.prepare('SELECT * FROM sheet_writes').get();
  assert.equal(row.state, 'pending');
  assert.match(row.last_error, /quota/);
});
