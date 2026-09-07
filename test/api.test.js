import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openMigrated } from '../src/db/index.js';
import { createHandler } from '../src/http/api.js';

import { setConfig, DEFAULT_CONFIG } from '../src/core/columns.js';

// тесты живут на схеме по умолчанию, а не на боевом config/columns.json
setConfig(DEFAULT_CONFIG);

// схема по умолчанию: B компания, C контакт, D телефон, E лидген, F тип, G статус
const HEAD = ['Дата', 'Компания', 'Контакт', 'Телефон', 'Лидген', 'Тип лида', 'Статус'];
const rows = (...list) => list.map((cells, i) => ({ key: `Лист1:${i + 2}`, cells }));
const row = (company, phone, gen, type, status = '') => ['01.09', company, '', phone, gen, type, status];

async function withServer(fn) {
  const db = openMigrated(':memory:');
  for (let i = 1; i <= 4; i++) {
    db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (?, ?, ?)').run(i, `Команда ${i}`, i);
  }
  const server = createServer(createHandler(db, { importNow: async () => ({ stub: true }) }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try { await fn({ db, call }); } finally { server.close(); }
}

test('health отвечает', () => withServer(async ({ call }) => {
  assert.deepEqual((await call('/health')).body, { ok: true });
}));

test('заливка строк и распределение по кругу команд', () => withServer(async ({ call }) => {
  const imported = await call('/api/import/rows', 'POST', {
    rows: rows(
      row('ООО Ромашка', '901234567', 'Аня', 'Лид'),
      row('Chinor Group', '901234568', 'Аня', 'Лид'),
      row('Delta Trade', '901234569', 'Бек', 'Встреча'),
    ),
  });
  assert.equal(imported.body.created, 3);

  assert.deepEqual((await call('/api/dispatch', 'POST')).body, { seen: 3, assigned: 3 });

  const leads = (await call('/api/leads?status=assigned')).body;
  const byCompany = Object.fromEntries(leads.map((l) => [l.company, l.team_name]));
  assert.equal(byCompany['ООО Ромашка'], 'Команда 1');
  assert.equal(byCompany['Chinor Group'], 'Команда 2');
  assert.equal(byCompany['Delta Trade'], 'Команда 1');   // встречи — своя очередь
}));

test('фрод из СРМ закрывает компанию и даёт команде долг', () => withServer(async ({ call }) => {
  await call('/api/import/rows', 'POST', {
    rows: rows(row('ООО Ромашка', '901234567', 'Аня', 'Лид')),
  });
  await call('/api/dispatch', 'POST');

  // СРМ переписала статус в таблице
  await call('/api/import/rows', 'POST', {
    rows: rows(row('ООО Ромашка', '901234567', 'Аня', 'Лид', 'Отказ')),
  });

  assert.equal((await call('/api/leads?status=assigned')).body.length, 0);
  const [lead] = (await call('/api/leads?status=rejected')).body;
  assert.equal(lead.company, 'ООО Ромашка');

  const leadQueue = (await call('/api/queues')).body.find((q) => q.kind === 'lead');
  assert.equal(leadQueue.priority[0].team_name, 'Команда 1');
  assert.equal(leadQueue.preview[0].team_id, 1, 'долг гасится следующей компанией');
}));

test('ручное назначение и отметка «в работе»', () => withServer(async ({ call }) => {
  await call('/api/import/rows', 'POST', {
    rows: rows(row('ООО Ромашка', '901234567', 'Аня', 'Лид')),
  });
  const [lead] = (await call('/api/leads?status=new')).body;
  await call(`/api/leads/${lead.id}/assign`, 'POST', { team_id: 3 });
  await call(`/api/leads/${lead.id}/in-work`, 'POST');
  const stats = (await call('/api/stats')).body;
  assert.equal(stats.leads.in_work, 1);
  assert.equal(stats.teams.find((t) => t.id === 3).in_work, 1);
}));

test('карантин виден отдельно и возвращается в работу', () => withServer(async ({ call }) => {
  await call('/api/import/rows', 'POST', {
    rows: rows(row('', '', 'Бек', '')),
  });
  const [bad] = (await call('/api/leads?status=quarantine')).body;
  assert.match(bad.quarantine_reason, /нет/);
  await call(`/api/leads/${bad.id}/release`, 'POST');
  assert.equal((await call('/api/leads?status=new')).body.length, 1);
}));

test('схема колонок отдаётся наружу', () => withServer(async ({ call }) => {
  const cfg = (await call('/api/columns')).body;
  assert.equal(cfg.columns.company, 'B');
  assert.equal(cfg.statusColumn, 'G');
  assert.equal(cfg.leadTypes.meeting, 'встреча');
}));

test('команды: создание, порядок, отключение', () => withServer(async ({ call }) => {
  const created = (await call('/api/teams', 'POST', { name: 'Команда 5' })).body;
  await call(`/api/teams/${created.id}`, 'PATCH', { active: 0 });
  const teams = (await call('/api/teams')).body;
  assert.equal(teams.length, 5);
  assert.equal(teams.find((t) => t.id === created.id).active, 0);
}));
