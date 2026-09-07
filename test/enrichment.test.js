import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import { setConfig, DEFAULT_CONFIG } from '../src/core/columns.js';
import { importBatch } from '../src/core/importer.js';
import { toBatch } from '../src/adapters/sheets.js';
import { enrichPending } from '../src/core/enrichment.js';
import { deliverPending } from '../src/core/argusDelivery.js';
import { dispatchQueue, assignNext } from '../src/core/queue.js';
import { fetchCompany } from '../src/adapters/bitrix.js';

// A дата | B компания | C контакт | D телефон | E лидген | F тип | G статус | H id компании Б24
const CFG = setConfig({
  ...DEFAULT_CONFIG,
  columns: { ...DEFAULT_CONFIG.columns, b24_company_id: 'H' },
});
const HEAD = ['Дата', 'Компания', 'Контакт', 'Телефон', 'Лидген', 'Тип лида', 'Статус', 'ID Б24'];

function setup() {
  const db = openMigrated(':memory:');
  for (let i = 1; i <= 4; i++) {
    db.prepare('INSERT INTO teams (id, name, queue_order, argus_user_id) VALUES (?, ?, ?, ?)')
      .run(i, `Команда ${i}`, i, `user-${i}`);
  }
  return db;
}

const load = (db, ...rows) => importBatch(db, toBatch([HEAD, ...rows], CFG), CFG);
const rowWithB24 = (id = '4021') => ['01.09', '', '', '901234567', 'Аня', 'Лид', '', id];

const COMPANY = {
  b24_id: '4021',
  title: 'ООО Ромашка',
  inn: '301234567',
  orginfo_url: 'https://orginfo.uz/organization/1f31442fff2f/',
  oked: '14120 - Производство спецодежды',
  contacts: [{ b24_id: '77', full_name: 'Иванов Иван', phone: '+998901234567', email: 'i@r.uz' }],
};

beforeEach(() => { process.env.ARGUS_COMPANY_URL = 'https://argus.example/company'; });

test('строка с id компании Б24 ждёт карточку и в очередь не идёт', () => {
  const db = setup();
  load(db, rowWithB24());
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.enrich_state, 'pending');
  assert.equal(lead.b24_company_id, '4021');
  assert.deepEqual(dispatchQueue(db), { seen: 0, assigned: 0 }, 'нераспределённой её не считаем');
  assert.equal(assignNext(db, lead.id), null);
});

test('карточка из Б24 сохраняется, дальше идёт обычное назначение', async () => {
  const db = setup();
  load(db, rowWithB24());

  const res = await enrichPending(db, {
    fetchCompany: async (id) => { assert.equal(id, '4021'); return COMPANY; },
  });
  assert.deepEqual(res, { picked: 1, ready: 1, failed: 0 });

  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.enrich_state, 'ready');
  assert.equal(lead.company, 'ООО Ромашка', 'пустое название подтянулось из Б24');
  assert.equal(JSON.parse(lead.b24_snapshot).inn, '301234567');
  assert.equal(lead.argus_company_id, null, 'в Аргус пока не ходили: команда ещё не выбрана');

  assert.deepEqual(dispatchQueue(db), { seen: 1, assigned: 1 });
  assert.equal(db.prepare('SELECT assigned_team t FROM leads').get().t, 1);
  assert.equal(db.prepare('SELECT argus_state s FROM leads').get().s, 'pending', 'ждёт отправки в СРМ');
});

test('компания уезжает в Аргус на ответственного своей команды и с типом', async () => {
  const db = setup();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);   // команда 1

  const calls = [];
  const res = await deliverPending(db, {
    ensure: async (company, placement) => {
      calls.push({ company, placement });
      return { id: 'argus-900', created: true };
    },
  });
  assert.deepEqual(res, { picked: 1, sent: 1, failed: 0 });
  assert.equal(calls[0].company.inn, '301234567');
  assert.deepEqual(calls[0].placement, { assignedById: 'user-1', kind: 'lead' });

  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.argus_state, 'sent');
  assert.equal(lead.argus_company_id, 'argus-900');
});

test('у команды не выбран получатель — строка не уезжает, ошибка видна', async () => {
  const db = setup();
  db.prepare('UPDATE teams SET argus_user_id = NULL WHERE id = 1').run();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);

  const res = await deliverPending(db, { ensure: async () => { throw new Error('не должно вызываться'); } });
  assert.equal(res.failed, 1);
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.argus_state, 'pending');
  assert.match(lead.argus_error, /не выбран получатель/);
});

test('Аргус недоступен — пять попыток, потом failed, назначение не теряется', async () => {
  const db = setup();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);

  const boom = { ensure: async () => { throw new Error('Аргус companies.add: HTTP 500'); } };
  for (let i = 0; i < 5; i++) await deliverPending(db, boom);

  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.argus_state, 'failed');
  assert.equal(lead.status, 'assigned', 'команда за компанией остаётся');
  assert.equal((await deliverPending(db, boom)).picked, 0, 'бесконечно не долбим');
});

test('сбой Б24 оставляет строку на повтор, а не теряет её', async () => {
  const db = setup();
  load(db, rowWithB24());
  const res = await enrichPending(db, { fetchCompany: async () => { throw new Error('Б24 таймаут'); } });
  assert.deepEqual(res, { picked: 1, ready: 0, failed: 1 });
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.enrich_state, 'pending');
  assert.equal(lead.enrich_attempts, 1);
  assert.match(lead.enrich_error, /таймаут/);
});

test('после пяти неудач строка уходит в эскалацию', async () => {
  const db = setup();
  load(db, rowWithB24());
  const fail = { fetchCompany: async () => { throw new Error('нет доступа'); } };
  for (let i = 0; i < 5; i++) await enrichPending(db, fail);
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.enrich_state, 'failed');
  assert.equal(lead.status, 'escalated');
  assert.equal((await enrichPending(db, fail)).picked, 0, 'бесконечно не долбим');
});

test('строка без id компании Б24 распределяется как обычно', () => {
  const db = setup();
  load(db, ['01.09', 'ООО Ромашка', 'Иван', '901234567', 'Аня', 'Лид', '', '']);
  assert.equal(db.prepare('SELECT enrich_state e FROM leads').get().e, 'ready');
  assert.deepEqual(dispatchQueue(db), { seen: 1, assigned: 1 });
});

test('адаптер Б24 собирает поля компании и контакты', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop().replace('.json', '');
    calls.push(method);
    const body = { ok: true, status: 200, json: async () => ({ result: null }) };
    if (method === 'crm.company.get') {
      return { ...body, json: async () => ({ result: {
        ID: 4021, TITLE: 'ООО Ромашка',
        UF_CRM_64DB2D1742285: '', UF_CRM_UZB_INN_COMPANY: '301234567',
        UF_CRM_1754989588: 'https://orginfo.uz/organization/1f31442fff2f/',
        UF_CRM_1754990395249: '14120 - Производство спецодежды',
      } }) };
    }
    return { ...body, json: async () => ({ result: [{
      ID: 77, NAME: 'Иван', LAST_NAME: 'Иванов', SECOND_NAME: 'Петрович',
      PHONE: [{ VALUE: '+998901234567' }, { VALUE: '+998901112233' }],
      EMAIL: [{ VALUE: 'i@r.uz' }],
    }] }) };
  };

  process.env.B24_WEBHOOK_URL = 'https://portal.bitrix24.ru/rest/1/token/';
  const company = await fetchCompany(4021, { fetchImpl });
  assert.equal(company.title, 'ООО Ромашка');
  assert.equal(company.inn, '301234567', 'пустой основной ИНН подменяется старым полем');
  assert.equal(company.oked, '14120 - Производство спецодежды');
  assert.equal(company.contacts[0].full_name, 'Иванов Иван Петрович');
  assert.deepEqual(company.contacts[0].phones, ['+998901234567', '+998901112233']);
  assert.equal(company.contacts[0].email, 'i@r.uz');
  assert.deepEqual(calls, ['crm.company.get', 'crm.contact.list'],
    'контакты забираются одним запросом, а не по одному');
});
