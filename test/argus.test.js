import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { findCompanyByInn, createCompany, ensureCompany, assignCompany, okedCode } from '../src/adapters/argus.js';

const COMPANY = {
  b24_id: '4021',
  title: 'ООО Ромашка',
  inn: '301447821',
  orginfo_url: 'https://orginfo.uz/organization/1f31442fff2f/',
  oked: '14120 - Производство спецодежды',
  contacts: [{
    full_name: 'Иванов Иван', phone: '+998901234567',
    phones: ['+998901234567', '+998901112233'], emails: ['i@r.uz'],
  }],
};

// ответ crm-mvp на companies.list
const LIST = [
  { ID: 'ba6e0c1d', TITLE: 'ООО «Демо Клиент»', INN: '305123456', PHONE: [{ VALUE: '+998 90 123-45-67', VALUE_TYPE: 'MOBILE' }] },
  { ID: 'baa1dbcb', TITLE: 'ООО «Логос Групп»', INN: '301447821', PHONE: [{ VALUE: '+998980000000', VALUE_TYPE: 'MOBILE' }] },
];

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
const fail = (error, description) => ({ ok: false, status: 400, json: async () => ({ error, error_description: description }) });

beforeEach(() => {
  process.env.ARGUS_API_URL = 'https://crm-mvp.cloudplus.uz/api/rest/v1/portal/token';
});

test('без ARGUS_API_URL адаптер честно падает', async () => {
  delete process.env.ARGUS_API_URL;
  await assert.rejects(() => createCompany(COMPANY, {}, {}), /ARGUS_API_URL не задан/);
});

test('поиск по ИНН уходит фильтром в теле запроса', async () => {
  const seen = [];
  const id = await findCompanyByInn('301447821', {
    fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return ok(LIST); },
  });
  assert.equal(id, 'baa1dbcb');
  assert.match(seen[0].url, /\/companies\.list$/);
  assert.deepEqual(seen[0].body, { filter: { INN: '301447821' } });
});

test('код ОКЭД вытаскивается из строки Б24', () => {
  assert.equal(okedCode('14120 - Производство спецодежды'), '14120');
  assert.equal(okedCode('14120'), '14120');
  assert.equal(okedCode(''), null);
  assert.equal(okedCode(null), null);
});

test('ИНН сверяется по цифрам, лишние символы не мешают', async () => {
  const id = await findCompanyByInn('301-447-821', { fetchImpl: async () => ok(LIST) });
  assert.equal(id, 'baa1dbcb');
});

test('незнакомый ИНН — компании нет', async () => {
  assert.equal(await findCompanyByInn('999999999', { fetchImpl: async () => ok(LIST) }), null);
  assert.equal(await findCompanyByInn(null, { fetchImpl: async () => ok(LIST) }), null);
});

test('создание шлёт fields в формате Аргуса', async () => {
  const seen = [];
  const id = await createCompany(COMPANY, { assignedById: 'user-2', kind: 'meeting' }, {
    fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return ok({ ID: 'new-123' }); },
  });
  assert.equal(id, 'new-123');
  assert.match(seen[0].url, /\/companies\.add$/);

  const { fields } = seen[0].body;
  assert.ok(fields, 'тело обёрнуто в fields, как у Б24');
  assert.equal(fields.TITLE, 'ООО Ромашка');
  assert.equal(fields.INN, '301447821');
  assert.equal(fields.ORGINFO, 'https://orginfo.uz/organization/1f31442fff2f/');
  assert.equal(fields.OKED, '14120', 'ОКЭД уходит кодом, а не строкой с названием');
  assert.deepEqual(fields.PHONE, [
    { VALUE: '+998901234567', VALUE_TYPE: 'WORK' },
    { VALUE: '+998901112233', VALUE_TYPE: 'WORK' },
  ]);
  assert.deepEqual(fields.EMAIL, [{ VALUE: 'i@r.uz', VALUE_TYPE: 'WORK' }]);
  assert.equal(fields.CONTACT_NAME, 'Иванов Иван');
  assert.equal(fields.CONTACT_PHONE, '+998901234567');
  assert.equal(fields.CONTACT_EMAIL, 'i@r.uz');
  assert.equal(fields.ASSIGNED_BY_ID, 'user-2', 'компания заводится сразу на ответственного команды');
  assert.equal(fields.LEAD_TYPE, 'meeting', 'тип пишется в отдельное поле');
});

test('без ИНН компанию не отправляем: Аргус её всё равно не примет', async () => {
  let called = 0;
  await assert.rejects(
    () => createCompany({ ...COMPANY, inn: null }, {}, { fetchImpl: async () => { called++; return ok({ ID: 'x' }); } }),
    /нет ИНН/
  );
  assert.equal(called, 0, 'зря в API не ходим');
});

test('превышение лимита 60/мин — один повтор, а не падение', async () => {
  let calls = 0;
  const id = await createCompany(COMPANY, {}, {
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? { ok: false, status: 429, json: async () => ({}) }
        : ok({ ID: 'after-retry' });
    },
  });
  assert.equal(id, 'after-retry');
  assert.equal(calls, 2);
});

test('ошибка Аргуса разворачивается в понятный текст', async () => {
  await assert.rejects(
    () => createCompany(COMPANY, {}, { fetchImpl: async () => fail('BAD_REQUEST', 'OKED неизвестен') }),
    /Аргус companies\.add: OKED неизвестен/
  );
});

test('ответ без ID считается ошибкой, а не успехом', async () => {
  await assert.rejects(
    () => createCompany(COMPANY, {}, { fetchImpl: async () => ok(null) }),
    /не вернул ID/
  );
});

test('ensureCompany берёт существующую компанию вместо дубля', async () => {
  let added = 0;
  const res = await ensureCompany(COMPANY, {}, {
    fetchImpl: async (url) => {
      if (url.includes('companies.add')) { added++; return ok({ ID: 'new' }); }
      return ok(LIST);
    },
  });
  assert.deepEqual(res, { id: 'baa1dbcb', created: false });
  assert.equal(added, 0, 'повторно компанию не заводим');
});

test('ensureCompany заводит новую, если ИНН не нашёлся', async () => {
  const res = await ensureCompany({ ...COMPANY, inn: '777777777' }, { assignedById: 'user-3', kind: 'lead' }, {
    fetchImpl: async (url) => (url.includes('companies.add') ? ok({ ID: 'fresh' }) : ok(LIST)),
  });
  assert.deepEqual(res, { id: 'fresh', created: true });
});

test('существующая компания передаётся ответственному через companies.update', async () => {
  const calls = [];
  const res = await ensureCompany(COMPANY, { assignedById: 'user-9', kind: 'meeting' }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return url.includes('companies.update') ? ok({ ID: 'baa1dbcb' }) : ok(LIST);
    },
  });
  assert.deepEqual(res, { id: 'baa1dbcb', created: false });
  const update = calls.find((c) => c.url.includes('companies.update'));
  assert.ok(update, 'ответственный проставляется, а не теряется на найденной компании');
  assert.equal(update.body.ID, 'baa1dbcb');
  assert.deepEqual(update.body.fields, { ASSIGNED_BY_ID: 'user-9', LEAD_TYPE: 'meeting' },
    'шлём только назначение, карточку не перезаписываем');
});

test('назначения нет — companies.update не дёргаем впустую', async () => {
  assert.equal(await assignCompany('x', {}, { fetchImpl: async () => { throw new Error('не должно вызываться'); } }), false);
});

test('409 по ИНН на создании: находим компанию и назначаем, а не роняем строку', async () => {
  let updated = null;
  let lists = 0;
  const res = await ensureCompany({ ...COMPANY, inn: '301447821' }, { assignedById: 'user-4' }, {
    fetchImpl: async (url, init) => {
      if (url.includes('companies.add')) {
        return { ok: false, status: 409, json: async () => ({ error: 'CONFLICT', error_description: 'ИНН занят' }) };
      }
      if (url.includes('companies.update')) { updated = JSON.parse(init.body); return ok({}); }
      // первый list — компании ещё нет, второй (после 409) — уже есть
      lists++;
      return ok(lists === 1 ? [] : LIST);
    },
  });
  assert.deepEqual(res, { id: 'baa1dbcb', created: false });
  assert.equal(updated.fields.ASSIGNED_BY_ID, 'user-4');
});

test('неизвестный ОКЭД не хоронит компанию — заводим без кода', async () => {
  const bodies = [];
  const id = await createCompany(COMPANY, { assignedById: 'u1' }, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return { ok: false, status: 400, json: async () => ({ error: 'BAD_REQUEST', error_description: 'в справочнике нет значения «14120»' }) };
      }
      return ok({ ID: 'new-1' });
    },
  });
  assert.equal(id, 'new-1');
  assert.equal(bodies[0].fields.OKED, '14120', 'сначала пробуем с кодом');
  assert.equal(bodies[1].fields.OKED, undefined, 'потом без него');
  assert.equal(bodies[1].fields.ASSIGNED_BY_ID, 'u1', 'ответственный при этом не теряется');
});

test('прочие ошибки создания не заминаются повтором', async () => {
  let calls = 0;
  await assert.rejects(() => createCompany(COMPANY, {}, {
    fetchImpl: async () => { calls++; return fail('BAD_REQUEST', 'TITLE обязателен'); },
  }), /TITLE обязателен/);
  assert.equal(calls, 1);
});

test('фродовая компания в Аргус не уезжает', async () => {
  const { openMigrated } = await import('../src/db/index.js');
  const { pending } = await import('../src/core/argusDelivery.js');
  const db = openMigrated(':memory:');
  db.prepare('INSERT INTO teams (id, name, queue_order, argus_user_id) VALUES (1, ?, 1, ?)').run('К1', 'u1');
  for (const [id, status] of [[1, 'assigned'], [2, 'rejected'], [3, 'quarantine'], [4, 'escalated'], [5, 'in_work']]) {
    db.prepare(`INSERT INTO leads (id, source_key, source_hash, company, kind, status, assigned_team, argus_state)
                VALUES (?, ?, 'h', 'ООО', 'lead', ?, 1, 'pending')`).run(id, 'Лист1:' + id, status);
  }
  assert.deepEqual(pending(db).map((l) => l.id), [1, 5],
    'закрытая компания не должна появиться в СРМ — удалить её оттуда нечем');
});
