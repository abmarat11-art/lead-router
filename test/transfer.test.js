import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import { addMember } from '../src/core/teams.js';
import { collectContacts } from '../src/core/notify.js';
import { parseB24CompanyLink, transferCompany } from '../src/core/transfer.js';

function setup() {
  const db = openMigrated(':memory:');
  db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (1, ?, 1)').run('Команда 1');
  addMember(db, 1, { argus_user_id: 'aziztur', name: 'Азиз', telegram_chat_id: '55' });
  db.prepare("INSERT INTO tg_contacts (chat_id, name) VALUES ('55', 'Азиз')").run();
  return db;
}
const company = { b24_id: '4021', title: 'ООО Ромашка', inn: '123456789', contacts: [{ name: 'Вася', phones: ['+998'] }] };
const msg = (chat, text, id = 1) => ({ update_id: id, message: { from: { id: chat, first_name: 'X' }, chat: { id: chat }, text } });

test('ссылка Б24 разбирается в id, мусор — нет', () => {
  assert.equal(parseB24CompanyLink('https://acrm.site/crm/company/details/4021/'), '4021');
  assert.equal(parseB24CompanyLink('https://acrm.site/crm/company/details/4021/?tab=x'), '4021');
  assert.equal(parseB24CompanyLink(' 77 '), '77');
  assert.equal(parseB24CompanyLink('aziztur'), null);
  assert.equal(parseB24CompanyLink('https://acrm.site/crm/deal/details/9/'), null);
});

test('команда → просим ссылку → компания и контакты уезжают на отправителя', async () => {
  process.env.ARGUS_COMPANY_URL = 'https://argus/companies/{id}';
  const db = setup();
  const sent = [], placements = [];
  const deps = {
    fetch: async () => [msg(55, '/transfer', 1), msg(55, 'https://acrm.site/crm/company/details/4021/', 2)],
    send: async (chat, text) => sent.push(text),
    transfer: {
      fetchCompany: async (id) => { assert.equal(id, '4021'); return company; },
      ensureCompany: async (c, placement) => { placements.push(placement); return { id: 'arg-9', created: true, matched: false, contacts: { added: 1, skipped: 0, errors: [] } }; },
    },
  };
  await collectContacts(db, deps);
  assert.match(sent[0], /Пришлите ссылку/);
  assert.match(sent[1], /Готово.*argus\/companies\/arg-9.*ООО Ромашка/s);
  assert.match(sent[1], /Контактов перенесено: 1/);
  assert.deepEqual(placements, [{ assignedById: 'aziztur', kind: 'lead' }]);
  assert.equal(db.prepare("SELECT mode FROM tg_contacts WHERE chat_id = '55'").get().mode, null, 'режим сброшен');
  const ev = db.prepare("SELECT data FROM events WHERE kind = 'bot_transfer'").get();
  assert.match(ev.data, /"argus_company_id":"arg-9"/);
});

test('ссылка без команды тоже работает; дубль по ИНН — ссылка на существующую, без переназначения', async () => {
  const db = setup();
  const sent = [];
  await collectContacts(db, {
    fetch: async () => [msg(55, 'https://acrm.site/crm/company/details/4021/')],
    send: async (chat, text) => sent.push(text),
    transfer: {
      fetchCompany: async () => company,
      ensureCompany: async () => ({ id: 'arg-1', created: false, matched: true, responsible: 'other' }),
    },
  });
  assert.match(sent[0], /уже есть в Аргусе/);
  assert.match(sent[0], /Ответственного не менял/);
});

test('непривязанный чат — просим ID, в Аргус не ходим', async () => {
  const db = setup();
  db.prepare("INSERT INTO tg_contacts (chat_id) VALUES ('99')").run();
  const sent = [];
  let called = 0;
  await collectContacts(db, {
    fetch: async () => [msg(99, '/transfer')],
    send: async (chat, text) => sent.push(text),
    transfer: { fetchCompany: async () => { called++; return company; }, ensureCompany: async () => { called++; } },
  });
  assert.match(sent[0], /привяжите свой ID/);
  assert.equal(called, 0);
});

test('в режиме ждём ссылку: не ссылка — переспрашиваем; ошибка Б24 — говорим прямо', async () => {
  const db = setup();
  const sent = [];
  await collectContacts(db, {
    fetch: async () => [msg(55, '/transfer', 1), msg(55, 'ромашка', 2), msg(55, '4021', 3)],
    send: async (chat, text) => sent.push(text),
    transfer: { fetchCompany: async () => { throw new Error('компания 4021 не найдена в Б24'); } },
  });
  assert.match(sent[1], /не похоже на ссылку/);
  assert.match(sent[2], /Не смог прочитать компанию 4021/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'bot_transfer_failed'").get().c, 1);
});

test('обычный логин по-прежнему привязывает, перенос не мешает', async () => {
  const db = openMigrated(':memory:');
  db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (1, ?, 1)').run('Команда 1');
  addMember(db, 1, { argus_user_id: 'aziztur', name: 'Азиз' });
  const sent = [];
  await collectContacts(db, { fetch: async () => [msg(55, 'aziztur')], send: async (c, t) => sent.push(t) });
  assert.match(sent[0], /Команда 1/);
  const r = await transferCompany(db, { chatId: 55, b24Id: '1' }, { fetchCompany: async () => company, ensureCompany: async () => ({ id: 'a', created: true, matched: false }) });
  assert.match(r, /Готово/);
});

test('незнакомый ID Аргуса — лидген: сам попадает в команду «Лидгены» вне очереди и может переносить', async () => {
  const db = openMigrated(':memory:');
  db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (1, ?, 1)').run('Команда 1');
  const sent = [];
  await collectContacts(db, {
    fetch: async () => [msg(77, '/start', 1), msg(77, 'newlidgen', 2), msg(77, 'https://acrm.site/crm/company/details/5/', 3)],
    send: async (chat, text) => sent.push(text),
    transfer: {
      fetchCompany: async () => company,
      ensureCompany: async (c, placement) => { assert.equal(placement.assignedById, 'newlidgen'); return { id: 'arg-2', created: true, matched: false, contacts: { added: 0, skipped: 1, errors: [] } }; },
    },
  });
  assert.match(sent[1], /ID <b>newlidgen<\/b> привязан/);
  assert.match(sent[2], /Готово/);
  const team = db.prepare("SELECT * FROM teams WHERE name = 'Лидгены'").get();
  assert.equal(team.active, 0, 'в очередь не попадает');
  const m = db.prepare("SELECT * FROM team_members WHERE argus_user_id = 'newlidgen'").get();
  assert.equal(m.team_id, team.id);
  assert.equal(m.telegram_chat_id, '77');
  // повторная отправка того же ID — не дубль
  await collectContacts(db, { fetch: async () => [msg(77, 'newlidgen', 4)], send: async (c, t) => sent.push(t) });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM team_members WHERE argus_user_id = 'newlidgen'").get().c, 1);
});

test('кнопка «Перенос в Аргус» едет с ответами бота, слово с кнопки запускает перенос', async () => {
  const db = setup();
  const sent = [];
  await collectContacts(db, {
    fetch: async () => [msg(55, '/start', 1), msg(55, 'Перенос в Аргус', 2)],
    send: async (chat, text, opts) => sent.push({ text, opts }),
  });
  assert.match(sent[0].text, /Вы привязаны/);
  assert.equal(sent[0].opts.replyMarkup.keyboard[0][0].text, 'Перенос в Аргус');
  assert.match(sent[1].text, /Пришлите ссылку/);
});
