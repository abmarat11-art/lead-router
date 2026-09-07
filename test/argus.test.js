import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { findCompanyByInn, createCompany, ensureCompany } from '../src/adapters/argus.js';

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

// как реально отвечает crm-mvp: фильтр по INN игнорируется, отдаётся весь список
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
  await assert.rejects(() => createCompany(COMPANY), /ARGUS_API_URL не задан/);
});

test('поиск по ИНН фильтрует список сам, потому что Аргус этого не делает', async () => {
  const id = await findCompanyByInn('301447821', { fetchImpl: async () => ok(LIST) });
  assert.equal(id, 'baa1dbcb');
});

test('ИНН сверяется по цифрам, лишние символы не мешают', async () => {
  const id = await findCompanyByInn('301-447-821', { fetchImpl: async () => ok(LIST) });
  assert.equal(id, 'baa1dbcb');
});

test('незнакомый ИНН — компании нет', async () => {
  assert.equal(await findCompanyByInn('999999999', { fetchImpl: async () => ok(LIST) }), null);
  assert.equal(await findCompanyByInn(null, { fetchImpl: async () => ok(LIST) }), null);
});

test('создание шлёт поля в формате Аргуса', async () => {
  const seen = [];
  const id = await createCompany(COMPANY, {
    fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return ok({ ID: 'new-123' }); },
  });
  assert.equal(id, 'new-123');
  assert.match(seen[0].url, /\/companies\.add$/);

  const body = seen[0].body;
  assert.equal(body.TITLE, 'ООО Ромашка');
  assert.equal(body.INN, '301447821');
  assert.equal(body.WEB, 'https://orginfo.uz/organization/1f31442fff2f/');
  assert.deepEqual(body.PHONE, [
    { VALUE: '+998901234567', VALUE_TYPE: 'WORK' },
    { VALUE: '+998901112233', VALUE_TYPE: 'WORK' },
  ]);
  assert.deepEqual(body.EMAIL, [{ VALUE: 'i@r.uz', VALUE_TYPE: 'WORK' }]);
  assert.match(body.COMMENTS, /Иванов Иван/);
});

test('ошибка Аргуса разворачивается в понятный текст', async () => {
  await assert.rejects(
    () => createCompany({ ...COMPANY, title: null }, { fetchImpl: async () => fail('BAD_REQUEST', 'TITLE обязателен') }),
    /Аргус companies\.add: TITLE обязателен/
  );
});

test('ответ без ID считается ошибкой, а не успехом', async () => {
  await assert.rejects(
    () => createCompany(COMPANY, { fetchImpl: async () => ok(null) }),
    /не вернул ID/
  );
});

test('ensureCompany берёт существующую компанию вместо дубля', async () => {
  let added = 0;
  const res = await ensureCompany(COMPANY, {
    fetchImpl: async (url) => {
      if (url.includes('companies.add')) { added++; return ok({ ID: 'new' }); }
      return ok(LIST);
    },
  });
  assert.deepEqual(res, { id: 'baa1dbcb', created: false });
  assert.equal(added, 0, 'повторно компанию не заводим');
});

test('ensureCompany заводит новую, если ИНН не нашёлся', async () => {
  const res = await ensureCompany({ ...COMPANY, inn: '777777777' }, {
    fetchImpl: async (url) => (url.includes('companies.add') ? ok({ ID: 'fresh' }) : ok(LIST)),
  });
  assert.deepEqual(res, { id: 'fresh', created: true });
});
