import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openMigrated } from '../src/db/index.js';
import { createHandler } from '../src/http/api.js';

const HEADERS = ['Компания', 'Телефон', 'Язык клиента', 'Итог работы', 'Лидогенератор'];

async function withServer(fn) {
  const db = openMigrated(':memory:');
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

test('полный путь: команда -> сотрудник -> импорт -> распределение -> акцепт', () => withServer(async ({ call }) => {
  const team = (await call('/api/teams', 'POST', { name: 'Команда А' })).body;
  await call('/api/employees', 'POST', { team_id: team.id, name: 'Аня', langs: ['ru'], queue_order: 1 });

  const imported = await call('/api/import/rows', 'POST', {
    headers: HEADERS,
    rows: [{ key: 'Лист1:2', cells: ['ООО Ромашка', '901234567', 'рус', 'Лид', 'Бек'] }],
    team_id: team.id,
  });
  assert.equal(imported.body.created, 1);

  assert.equal((await call('/api/dispatch', 'POST')).body.offered, 1);

  const [lead] = (await call('/api/leads?status=offered')).body;
  assert.equal(lead.offer.employee_name, 'Аня');

  assert.deepEqual((await call(`/api/offers/${lead.offer.id}/accept`, 'POST')).body, { ok: true });
  assert.equal((await call('/api/stats')).body.leads.assigned, 1);
}));

test('отказ возвращает лид в очередь', () => withServer(async ({ call }) => {
  const team = (await call('/api/teams', 'POST', { name: 'А' })).body;
  await call('/api/employees', 'POST', { team_id: team.id, name: 'Аня', langs: [], queue_order: 1 });
  await call('/api/employees', 'POST', { team_id: team.id, name: 'Бек', langs: [], queue_order: 2 });
  await call('/api/import/rows', 'POST', {
    headers: HEADERS, team_id: team.id,
    rows: [{ key: 'Лист1:2', cells: ['ООО Ромашка', '901234567', 'рус', 'Лид', 'Бек'] }],
  });
  await call('/api/dispatch', 'POST');
  const [lead] = (await call('/api/leads?status=offered')).body;
  await call(`/api/offers/${lead.offer.id}/decline`, 'POST', { reason: 'не мой язык' });
  const [again] = (await call('/api/leads?status=offered')).body;
  assert.notEqual(again.offer.employee_id, lead.offer.employee_id);
}));

test('карантин виден отдельно и возвращается в работу', () => withServer(async ({ call }) => {
  await call('/api/import/rows', 'POST', {
    headers: HEADERS, rows: [{ key: 'Лист1:2', cells: ['', '', '', '', 'Бек'] }],
  });
  const [bad] = (await call('/api/leads?status=quarantine')).body;
  assert.match(bad.quarantine_reason, /нет/);
  await call(`/api/leads/${bad.id}/release`, 'POST');
  assert.equal((await call('/api/leads?status=new')).body.length, 1);
}));

