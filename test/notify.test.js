import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import { addMember, teamHistory } from '../src/core/teams.js';
import { enqueueAssignment, flushNotifications, buildText, companyLinks, collectContacts, knownContacts, bindByLogin } from '../src/core/notify.js';

function setup() {
  const db = openMigrated(':memory:');
  db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (1, ?, 1)').run('Команда 1');
  db.prepare(`INSERT INTO leads (id, source_key, source_hash, company, kind, lead_gen,
              assigned_team, b24_company_id, argus_company_id)
              VALUES (1, 'Лист1:3', 'h', 'ООО Ромашка', 'meeting', 'Тагир', 1, '4021', 'arg-77')`).run();
  return db;
}

test('уведомления уходят получателю и списку, минуя непривязанных', () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'u1', name: 'Ойбек', role: 'assignee', telegram_chat_id: '111' });
  addMember(db, 1, { argus_user_id: 'u2', name: 'Костя', telegram_chat_id: '222' });
  addMember(db, 1, { argus_user_id: 'u3', name: 'Без телеграма' });

  const out = enqueueAssignment(db, 1, 1);
  assert.deepEqual(out, { queued: 2, skipped: 1 });

  const rows = db.prepare('SELECT * FROM tg_outbox ORDER BY id').all();
  assert.match(rows[0].text, /Вам назначено/, 'получателю — что компания на нём');
  assert.match(rows[1].text, /для информации/, 'остальным — к сведению');
});

test('выключенный участник уведомлений не получает', () => {
  const db = setup();
  const id = addMember(db, 1, { argus_user_id: 'u1', telegram_chat_id: '111' });
  db.prepare('UPDATE team_members SET active = 0 WHERE id = ?').run(id);
  assert.deepEqual(enqueueAssignment(db, 1, 1), { queued: 0, skipped: 0 });
});

test('повторный проход не задваивает уведомление', () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'u1', telegram_chat_id: '111' });
  enqueueAssignment(db, 1, 1);
  enqueueAssignment(db, 1, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tg_outbox').get().c, 1);
});

test('в тексте обе ссылки на карточки', () => {
  process.env.ARGUS_COMPANY_URL = 'https://crm-mvp.cloudplus.uz/companies/{id}';
  process.env.B24_COMPANY_URL = 'https://acrm.site/crm/company/details/{id}/';
  const lead = { company: 'ООО Ромашка', kind: 'lead', argus_company_id: 'arg-77', b24_company_id: '4021' };
  const links = companyLinks(lead);
  assert.equal(links.length, 2);
  assert.match(links[0], /companies\/arg-77/);
  assert.match(links[1], /company\/details\/4021/);
  delete process.env.ARGUS_COMPANY_URL;
  delete process.env.B24_COMPANY_URL;
});

test('без настроенных адресов ссылки просто не добавляются', () => {
  const text = buildText({ company: 'ООО Ромашка', kind: 'lead' }, { name: 'Команда 1' }, { forAssignee: true });
  assert.match(text, /ООО Ромашка/);
  assert.doesNotMatch(text, /href/);
});

test('угловые скобки в названии не ломают разметку', () => {
  const text = buildText({ company: 'ООО <Ромашка>', kind: 'lead' }, { name: 'К1' }, { forAssignee: false });
  assert.match(text, /&lt;Ромашка&gt;/);
});

test('человек не нажал «Старт» — повторов нет, ошибка видна', async () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'u1', telegram_chat_id: '111' });
  enqueueAssignment(db, 1, 1);

  const out = await flushNotifications(db, {
    send: async () => { const e = new Error('Телеграм: bot was blocked by the user'); e.code = 403; throw e; },
  });
  assert.deepEqual(out, { picked: 1, sent: 0, failed: 1 });
  const row = db.prepare('SELECT * FROM tg_outbox WHERE id = 1').get();
  assert.equal(row.state, 'failed', 'бесконечно долбиться в закрытую дверь незачем');
  assert.match(row.last_error, /blocked/);
});

test('сетевой сбой — повтор позже, не потеря', async () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'u1', telegram_chat_id: '111' });
  enqueueAssignment(db, 1, 1);

  await flushNotifications(db, { send: async () => { throw new Error('ECONNRESET'); } });
  const row = db.prepare('SELECT * FROM tg_outbox WHERE id = 1').get();
  assert.equal(row.state, 'pending');
  assert.equal(row.attempts, 1);
});

test('успешная отправка помечается и больше не берётся', async () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'u1', telegram_chat_id: '111' });
  enqueueAssignment(db, 1, 1);

  const seen = [];
  const first = await flushNotifications(db, { send: async (chat, text) => seen.push({ chat, text }) });
  assert.deepEqual(first, { picked: 1, sent: 1, failed: 0 });
  assert.equal(seen[0].chat, '111');

  const second = await flushNotifications(db, { send: async () => { throw new Error('не должно вызываться'); } });
  assert.equal(second.picked, 0);
});

test('кто написал боту — запоминается у нас, а не живёт сутки в телеграме', async () => {
  const db = setup();
  const sent = [];
  const updates = [
    { update_id: 10, message: { from: { id: 5, first_name: 'Азиз', last_name: 'Турдиев', username: 'aziz' }, chat: { id: 5 } } },
    { update_id: 11, message: { from: { id: 7, first_name: 'Тагир' }, chat: { id: 7 } } },
  ];
  const out = await collectContacts(db, {
    fetch: async () => updates,
    send: async (chat, text) => sent.push({ chat, text }),
  });
  assert.deepEqual(out, { seen: 2, added: 2 });
  assert.equal(sent.length, 2, 'человеку подтверждаем, что нажатие сработало');

  const list = knownContacts(db);
  assert.deepEqual(list.map((c) => c.chat_id).sort(), ['5', '7']);
  assert.equal(list.find((c) => c.chat_id === '5').name, 'Азиз Турдиев');
});

test('человек прислал логин Аргуса — привязался сам, без руководителя', async () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'aziztur', name: 'Азиз Турдиев' });

  const sent = [];
  await collectContacts(db, {
    fetch: async () => [
      { update_id: 1, message: { from: { id: 55, first_name: 'Азиз' }, chat: { id: 55 }, text: '/start' } },
      { update_id: 2, message: { from: { id: 55, first_name: 'Азиз' }, chat: { id: 55 }, text: ' AzizTur ' } },
    ],
    send: async (chat, text) => sent.push(text),
  });

  const member = db.prepare("SELECT * FROM team_members WHERE argus_user_id = 'aziztur'").get();
  assert.equal(member.telegram_chat_id, '55', 'регистр и пробелы в логине не мешают');
  assert.match(sent[0], /логин в Аргусе/, 'на «Старт» просим логин');
  assert.match(sent[1], /Команда 1/, 'подтверждаем команду, чтобы человек видел результат');
});

test('незнакомый логин — говорим прямо, а не молчим', async () => {
  const db = setup();
  const sent = [];
  await collectContacts(db, {
    fetch: async () => [{ update_id: 1, message: { from: { id: 55 }, chat: { id: 55 }, text: 'кто-то-левый' } }],
    send: async (chat, text) => sent.push(text),
  });
  assert.match(sent[0], /Такого логина в списке команд нет/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM team_members WHERE telegram_chat_id IS NOT NULL').get().c, 0);
});

test('привязка по логину пишется в журнал команды', () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'aziztur', name: 'Азиз' });
  assert.equal(bindByLogin(db, '77', 'aziztur').ok, true);
  const last = teamHistory(db, 1)[0];
  assert.match(last.data, /77/);
});

test('повторный проход не здоровается заново и двигает курсор', async () => {
  const db = setup();
  const upd = [{ update_id: 10, message: { from: { id: 5, first_name: 'Азиз' }, chat: { id: 5 } } }];
  let offset = null;
  await collectContacts(db, { fetch: async () => upd, send: async () => {} });

  let greeted = 0;
  const second = await collectContacts(db, {
    fetch: async (o) => { offset = o; return upd; },
    send: async () => { greeted++; },
  });
  assert.equal(offset, 11, 'просим только то, чего ещё не видели');
  assert.equal(second.added, 0);
  assert.equal(greeted, 0, 'второе «здравствуйте» — спам');
});

test('в списке видно, кому chat id уже привязан', async () => {
  const db = setup();
  await collectContacts(db, {
    fetch: async () => [{ update_id: 1, message: { from: { id: 111, first_name: 'Костя' }, chat: { id: 111 } } }],
    send: async () => {},
  });
  addMember(db, 1, { argus_user_id: 'u1', name: 'Константин Ю', telegram_chat_id: '111' });
  assert.equal(knownContacts(db)[0].bound_to, 'Константин Ю');
});

test('сообщения от других ботов в контакты не попадают', async () => {
  const db = setup();
  const out = await collectContacts(db, {
    fetch: async () => [{ update_id: 1, message: { from: { id: 9, first_name: 'Бот', is_bot: true }, chat: { id: 9 } } }],
    send: async () => {},
  });
  assert.equal(out.added, 0);
  assert.equal(knownContacts(db).length, 0);
});
