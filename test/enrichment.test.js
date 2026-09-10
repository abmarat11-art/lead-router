import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import { setConfig, DEFAULT_CONFIG } from '../src/core/columns.js';
import { importBatch } from '../src/core/importer.js';
import { toBatch } from '../src/adapters/sheets.js';
import { enrichPending } from '../src/core/enrichment.js';
import { deliverPending } from '../src/core/argusDelivery.js';
import { dispatchQueue, assignNext, assignManually } from '../src/core/queue.js';
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
  assert.deepEqual(res, { picked: 1, sent: 1, failed: 0, matched: 0 });
  assert.equal(calls[0].company.inn, '301234567');
  assert.deepEqual(calls[0].placement, { assignedById: 'user-1', kind: 'lead', notifyIds: [] });

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

test('компания уже в Аргусе: не переназначаем, ход не засчитан, сигнал руководителю', async () => {
  const db = setup();
  // Тагир ведёт компанию в Аргусе и состоит в команде 3; руководитель этой команды — Сардор.
  db.prepare("INSERT INTO team_members (team_id, argus_user_id, name, role, telegram_chat_id) VALUES (3, 'tagirsol', 'Тагир', 'notify', '111')").run();
  db.prepare("INSERT INTO team_members (team_id, argus_user_id, name, role, telegram_chat_id) VALUES (3, 'sardor', 'Сардор', 'assignee', '222')").run();

  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);   // строка выпала команде 1

  const res = await deliverPending(db, {
    ensure: async () => ({ id: 'argus-77', created: false, matched: true, responsible: 'tagirsol', title: 'ООО Ромашка' }),
  });
  assert.deepEqual(res, { picked: 1, sent: 0, failed: 0, matched: 1 });

  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.argus_state, 'matched');
  assert.equal(lead.status, 'rejected', 'строка закрыта как фрод');
  assert.equal(lead.argus_company_id, 'argus-77');

  const debt = db.prepare('SELECT * FROM queue_priority WHERE consumed_at IS NULL').get();
  assert.equal(debt.team_id, 1, 'ход команде 1 возвращается долгом');

  const out = db.prepare('SELECT * FROM tg_outbox').all();
  assert.equal(out.length, 1, 'уведомления о назначении нет, только сигнал');
  assert.equal(out[0].chat_id, '222', 'пишем руководителю команды ответственного, не самому ответственному');
  assert.match(out[0].text, /уже ведётся в Аргусе/);
  assert.match(out[0].text, /tagirsol/);
});

test('ответственный не найден в командах — сигнал уходит в резервный чат', async () => {
  process.env.DUPLICATE_ALERT_CHAT_ID = '999';
  const db = setup();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);

  await deliverPending(db, {
    ensure: async () => ({ id: 'argus-78', created: false, matched: true, responsible: null, title: 'ООО Ромашка' }),
  });
  const out = db.prepare('SELECT * FROM tg_outbox').all();
  assert.equal(out.length, 1);
  assert.equal(out[0].chat_id, '999');
  delete process.env.DUPLICATE_ALERT_CHAT_ID;
});

test('два прохода доставки не берут одну строку дважды', async () => {
  const db = setup();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);

  let calls = 0;
  const slow = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return { id: 'argus-1', created: true, matched: false };
  };
  const [a, b] = await Promise.all([deliverPending(db, { ensure: slow }), deliverPending(db, { ensure: slow })]);
  assert.equal(calls, 1, 'в Аргус ходим один раз');
  assert.equal(a.sent + b.sent, 1, 'строка уезжает ровно один раз');
  assert.equal(db.prepare('SELECT argus_state s FROM leads').get().s, 'sent');
});

test('брошенная на полпути строка возвращается в доставку', async () => {
  const db = setup();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);

  // проход умер, не вернув строку: состояние осталось 'sending' полчаса назад
  db.prepare("UPDATE leads SET argus_state = 'sending', updated_at = datetime('now', '-30 minutes')").run();
  const res = await deliverPending(db, { ensure: async () => ({ id: 'argus-2', created: true, matched: false }) });
  assert.equal(res.sent, 1);

  // свежая занятая строка так и остаётся у своего прохода
  db.prepare("UPDATE leads SET argus_state = 'sending', updated_at = datetime('now')").run();
  assert.deepEqual(await deliverPending(db, { ensure: async () => { throw new Error('не должно вызываться'); } }),
    { picked: 0, sent: 0, failed: 0, matched: 0 });
});

test('своя компания при повторной доставке — не фрод, а подтверждение назначения', async () => {
  const db = setup();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);
  await deliverPending(db, {
    ensure: async (c, p, opts) => { await opts.onCreateAttempt?.(); return { id: 'argus-5', created: true, matched: false }; },
  });

  // ручное переназначение на другую команду возвращает строку в доставку
  assignManually(db, db.prepare('SELECT id FROM leads').get().id, 2);
  const assigned = [];
  const res = await deliverPending(db, {
    ensure: async () => ({ id: 'argus-5', created: false, matched: true, responsible: 'someone', title: 'ООО Ромашка' }),
    assign: async (id, placement) => { assigned.push({ id, placement }); return true; },
  });
  assert.deepEqual(res, { picked: 1, sent: 1, failed: 0, matched: 0 }, 'фродом не считаем — компанию заводили мы');
  assert.deepEqual(assigned, [{ id: 'argus-5', placement: { assignedById: 'user-2', kind: 'lead', notifyIds: [] } }]);

  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.status, 'assigned');
  assert.equal(lead.argus_state, 'sent');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM queue_priority').get().c, 0, 'долгов быть не должно');
});

test('чужая компания не попадает в «Отказы» команды — это не её отказ', async () => {
  const db = setup();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);
  await deliverPending(db, {
    ensure: async () => ({ id: 'argus-6', created: false, matched: true, responsible: 'tagirsol', title: 'ООО Ромашка' }),
  });
  const a = db.prepare('SELECT * FROM assignments').get();
  assert.equal(a.state, 'cancelled', 'назначение отменено, а не отклонено командой');
  assert.equal(db.prepare('SELECT decline_count c FROM leads').get().c, 0);
});

test('оборвалась связь после заведения — вторая попытка не считает свою компанию чужой', async () => {
  const db = setup();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);

  // первый проход: компанию завели, но ответ до нас не дошёл
  await deliverPending(db, {
    ensure: async (c, p, opts) => { await opts.onCreateAttempt?.(); throw new Error('соединение оборвано'); },
  });
  assert.equal(db.prepare('SELECT argus_state s FROM leads').get().s, 'pending');

  // второй проход находит её же по ИНН — ответственного Аргус не отдаёт
  const res = await deliverPending(db, {
    ensure: async () => ({ id: 'argus-9', created: false, matched: true, responsible: null, title: 'ООО Ромашка' }),
    assign: async () => true,
  });
  assert.deepEqual(res, { picked: 1, sent: 1, failed: 0, matched: 0 });
  const lead = db.prepare('SELECT * FROM leads').get();
  assert.equal(lead.status, 'assigned', 'фродом свою же компанию не объявляем');
  assert.equal(lead.argus_company_id, 'argus-9');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM queue_priority').get().c, 0);
});

test('строка на время похода в СРМ занята и попытка уже посчитана', async () => {
  const db = setup();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);

  let inFlight = null;
  await deliverPending(db, {
    ensure: async () => {
      inFlight = db.prepare('SELECT argus_state, argus_attempts FROM leads').get();
      throw new Error('обрыв');
    },
  });
  assert.equal(inFlight.argus_state, 'sending', 'на время похода строку никто не подберёт');
  assert.equal(inFlight.argus_attempts, 1, 'попытка считается сразу, а не только при возврате');
});

test('обрыв до заведения не даёт присвоить чужую компанию на второй попытке', async () => {
  const db = setup();
  load(db, rowWithB24());
  await enrichPending(db, { fetchCompany: async () => COMPANY });
  dispatchQueue(db);

  // первый проход упал на поиске — заводить компанию мы даже не начинали
  await deliverPending(db, { ensure: async () => { throw new Error('Аргус недоступен'); } });

  let assigned = 0;
  const res = await deliverPending(db, {
    ensure: async () => ({ id: 'argus-чужой', created: false, matched: true, responsible: null, title: 'ООО Чужая' }),
    assign: async () => { assigned++; return true; },
  });
  assert.equal(res.matched, 1, 'чужая компания остаётся чужой');
  assert.equal(assigned, 0, 'ответственного не переписываем');
});
