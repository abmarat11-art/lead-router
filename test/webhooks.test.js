import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openMigrated } from '../src/db/index.js';
import { enqueueWebhook, flushOutbox } from '../src/core/webhooks.js';
import { offerLead, acceptOffer } from '../src/core/router.js';

function setup() {
  const db = openMigrated(':memory:');
  db.prepare('INSERT INTO teams (id, name) VALUES (1, ?)').run('Команда А');
  db.prepare('INSERT INTO employees (id, team_id, name, langs, queue_order) VALUES (1, 1, ?, ?, 1)')
    .run('Аня', '["ru"]');
  db.prepare('INSERT INTO leads (id, source_key, source_hash, company, lang, team_id) VALUES (1, ?, ?, ?, ?, 1)')
    .run('Лист1:2', 'h', 'ООО Ромашка', 'ru');
  return db;
}

beforeEach(() => {
  process.env.ARGUS_WEBHOOK_URL = 'https://argus.example/hook';
  process.env.ARGUS_WEBHOOK_SECRET = 'secret';
});

test('без настроенного URL вебхуки не копятся', () => {
  delete process.env.ARGUS_WEBHOOK_URL;
  const db = setup();
  assert.equal(enqueueWebhook(db, 'lead.assigned', 1, 1), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM webhook_outbox').get().c, 0);
});

test('принятие лида кладёт lead.assigned в outbox с данными лида и сотрудника', () => {
  const db = setup();
  acceptOffer(db, offerLead(db, 1).id);
  const row = db.prepare('SELECT * FROM webhook_outbox').get();
  assert.equal(row.event, 'lead.assigned');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.lead.company, 'ООО Ромашка');
  assert.equal(payload.lead.source_key, 'Лист1:2');
  assert.equal(payload.employee.name, 'Аня');
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

test('ошибка CRM оставляет задачу в очереди с ретраем', async () => {
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
