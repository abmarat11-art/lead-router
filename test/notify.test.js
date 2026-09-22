import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../src/db/index.js';
import { addMember, teamHistory } from '../src/core/teams.js';
import { enqueueAssignment, flushNotifications, buildText, companyLinks, collectContacts, knownContacts, bindByLogin, takeLead, handleCallback, assignmentButtons, buildTakenText } from '../src/core/notify.js';

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
  assert.deepEqual(out, { seen: 2, added: 2, taken: 0 });
  assert.equal(sent.length, 2, 'человеку подтверждаем, что нажатие сработало');

  const list = knownContacts(db);
  assert.deepEqual(list.map((c) => c.chat_id).sort(), ['5', '7']);
  assert.equal(list.find((c) => c.chat_id === '5').name, 'Азиз Турдиев');
});

test('человек прислал ID Аргуса — привязался сам, без руководителя', async () => {
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
  assert.match(sent[0], /ID в Аргусе/, 'на «Старт» просим ID');
  assert.match(sent[1], /Команда 1/, 'подтверждаем команду, чтобы человек видел результат');
});

test('незнакомый ID — говорим прямо, а не молчим', async () => {
  const db = setup();
  const sent = [];
  await collectContacts(db, {
    fetch: async () => [{ update_id: 1, message: { from: { id: 55 }, chat: { id: 55 }, text: 'кто-то-левый' } }],
    send: async (chat, text) => sent.push(text),
  });
  assert.match(sent[0], /не похоже на ID Аргуса/);
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

test('одинаковый отказ подряд не шлём: человек перебирает варианты, а не читает стену', async () => {
  const db = setup();
  const sent = [];
  const send = async (chat, text) => sent.push(text);
  const upd = (id, text) => ({ update_id: id, message: { from: { id: 5, first_name: 'Кто-то' }, chat: { id: 5 }, text } });

  await collectContacts(db, { fetch: async () => [upd(1, '/start')], send });
  await collectContacts(db, { fetch: async () => [upd(2, 'mail@example.com')], send });
  await collectContacts(db, { fetch: async () => [upd(3, 'пароль2801')], send });
  await collectContacts(db, { fetch: async () => [upd(4, 'ещё попытка')], send });

  assert.equal(sent.length, 2, 'приветствие и один отказ — подряд не повторяемся');
  assert.match(sent[0], /ID в Аргусе/);
  assert.match(sent[1], /не похоже на ID Аргуса/);
});

test('после отказов верный ID всё равно принимается', async () => {
  const db = setup();
  addMember(db, 1, { argus_user_id: 'aziztur', name: 'Азиз' });
  const sent = [];
  const send = async (chat, text) => sent.push(text);
  const upd = (id, text) => ({ update_id: id, message: { from: { id: 5 }, chat: { id: 5 }, text } });

  await collectContacts(db, { fetch: async () => [upd(1, 'ерунда')], send });
  await collectContacts(db, { fetch: async () => [upd(2, 'aziztur')], send });

  assert.equal(db.prepare("SELECT telegram_chat_id t FROM team_members WHERE argus_user_id='aziztur'").get().t, '5');
  assert.match(sent[sent.length - 1], /Команда 1/);
});

test('через минуту молчания отвечаем снова: человек не должен решить, что бот умер', async () => {
  const db = setup();
  const sent = [];
  const send = async (chat, text) => sent.push(text);
  const upd = (id, text) => ({ update_id: id, message: { from: { id: 5 }, chat: { id: 5 }, text } });

  await collectContacts(db, { fetch: async () => [upd(1, 'карина@почта')], send });
  await collectContacts(db, { fetch: async () => [upd(2, 'карина@почта')], send });
  assert.equal(sent.length, 1, 'сразу подряд — один ответ');

  // «прошла минута»
  db.prepare("UPDATE tg_contacts SET last_reply_at = datetime('now', '-2 minutes')").run();
  await collectContacts(db, { fetch: async () => [upd(3, 'карина@почта')], send });
  assert.equal(sent.length, 2, 'через минуту отвечаем снова');
});

test('сигнал о чужой компании уходит без кнопки фидбэка', async () => {
  const db = openMigrated(':memory:');
  db.prepare("INSERT INTO teams (id, name, queue_order) VALUES (1, 'Команда 1', 1)").run();
  db.prepare("INSERT INTO leads (id, source_key, source_hash, company, kind, status) VALUES (1, 'Лист1:2', 'h', 'ООО Ромашка', 'lead', 'rejected')").run();
  db.prepare("INSERT INTO tg_outbox (lead_id, team_id, member_id, chat_id, text) VALUES (1, 1, NULL, '222', 'сигнал')").run();
  process.env.MINIAPP_URL = 'https://lidgen.example';

  const seen = [];
  await flushNotifications(db, { send: async (chat, text, opts) => { seen.push({ chat, opts }); } });
  assert.equal(seen[0].opts.replyMarkup, undefined);
  delete process.env.MINIAPP_URL;
});

// ---- «Взял в работу» ----

function teamOfThree(db) {
  const a = addMember(db, 1, { argus_user_id: 'bekhruz', name: 'Бехруз Тамиров', role: 'assignee', telegram_chat_id: '111' });
  const b = addMember(db, 1, { argus_user_id: 'artem', name: 'Артём Лугнов', telegram_chat_id: '222' });
  const c = addMember(db, 1, { argus_user_id: 'nobody', name: 'Без телеграма' });
  return { a, b, c };
}

test('под назначением две кнопки: фидбэк и «Взял в работу»', () => {
  process.env.MINIAPP_URL = 'https://lidgen.example';
  const kb = assignmentButtons(1).inline_keyboard;
  assert.equal(kb.length, 2);
  assert.match(kb[0][0].text, /фидбэк/);
  assert.equal(kb[1][0].callback_data, 'take:1');
  delete process.env.MINIAPP_URL;
  // без мини-аппа — только «Взял»
  assert.equal(assignmentButtons(1).inline_keyboard.length, 1);
  // компания взята — кнопка превращается в подпись
  const done = assignmentButtons(1, { take: { name: 'Бехруз Тамиров' } }).inline_keyboard[0][0];
  assert.equal(done.callback_data, 'taken:1');
  assert.match(done.text, /Бехруз/);
});

test('отправка запоминает message_id — потом это сообщение цитируем', async () => {
  const db = setup();
  teamOfThree(db);
  enqueueAssignment(db, 1, 1);
  let n = 500;
  await flushNotifications(db, { send: async () => ({ message_id: ++n }) });
  const rows = db.prepare("SELECT chat_id, message_id FROM tg_outbox WHERE kind = 'assign' ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ chat_id: '111', message_id: '501' }, { chat_id: '222', message_id: '502' }]);
});

test('взял в работу — остальным уходит уведомление с цитатой их назначения', async () => {
  const db = setup();
  const { a } = teamOfThree(db);
  enqueueAssignment(db, 1, 1);
  let n = 500;
  await flushNotifications(db, { send: async () => ({ message_id: ++n }) });

  const res = takeLead(db, 1, '111');
  assert.equal(res.ok, true);
  assert.equal(res.take.member_id, a);
  assert.equal(res.take.name, 'Бехруз Тамиров');
  assert.equal(res.queued, 1, 'Артёму — да, взявшему и человеку без телеграма — нет');

  const row = db.prepare("SELECT * FROM tg_outbox WHERE kind = 'taken'").get();
  assert.equal(row.chat_id, '222');
  assert.equal(row.reply_to, '502', 'цитата — сообщение о назначении именно Артёма');
  assert.match(row.text, /Бехруз Тамиров взял\(а\) в работу в \d\d:\d\d \d\d\.\d\d/);
  assert.match(row.text, /ООО Ромашка/);

  const sent = [];
  await flushNotifications(db, { send: async (chat, text, opts) => { sent.push({ chat, opts }); return { message_id: 1 }; } });
  assert.equal(sent[0].opts.replyTo, '502');
  assert.equal(sent[0].opts.replyMarkup, undefined, 'под «взято» кнопок нет');

  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'taken' AND lead_id = 1").get().c, 1);
});

test('второе нажатие не перезаписывает первого взявшего', () => {
  const db = setup();
  teamOfThree(db);
  assert.equal(takeLead(db, 1, '222').ok, true, 'взять может любой участник команды, не только получатель');
  const again = takeLead(db, 1, '111');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'taken');
  assert.equal(again.take.name, 'Артём Лугнов');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lead_takes').get().c, 1);
});

test('чужой команде и незнакомому чату кнопка не работает', () => {
  const db = setup();
  teamOfThree(db);
  db.prepare("INSERT INTO teams (id, name, queue_order) VALUES (2, 'Команда 2', 2)").run();
  addMember(db, 2, { argus_user_id: 'x', name: 'Чужой', telegram_chat_id: '999' });
  assert.equal(takeLead(db, 1, '999').reason, 'not_member');
  assert.equal(takeLead(db, 1, '777').reason, 'not_member');
  assert.equal(takeLead(db, 42, '111').reason, 'not_found');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tg_outbox WHERE kind = 'taken'").get().c, 0);
});

test('нажатие кнопки в телеграме: ответ нажавшему, кнопки гаснут у всех, повтор — «уже взял»', async () => {
  const db = setup();
  teamOfThree(db);
  enqueueAssignment(db, 1, 1);
  let n = 500;
  await flushNotifications(db, { send: async () => ({ message_id: ++n }) });

  const answers = [], edits = [];
  const cq = (id, chat, data) => ({ update_id: id, callback_query: {
    id: `cb${id}`, data, from: { id: Number(chat), first_name: 'x' }, message: { chat: { id: Number(chat) }, message_id: 1 } } });

  const out = await collectContacts(db, {
    fetch: async () => [cq(30, '111', 'take:1')],
    send: async () => {},
    answer: async (id, o) => answers.push({ id, ...o }),
    editMarkup: async (chat, mid, markup) => edits.push({ chat, mid, btn: markup.inline_keyboard.at(-1)[0].text }),
  });
  assert.deepEqual(out, { seen: 1, added: 0, taken: 1 });
  assert.match(answers[0].text, /Взято в работу/);
  assert.deepEqual(edits.map((e) => [e.chat, e.mid]).sort(), [['111', '501'], ['222', '502']], 'кнопка гаснет у обоих');
  assert.match(edits[0].btn, /В работе: Бехруз/);

  // Артём жмёт следом — всплывашка, кто уже взял; ничего не дублируется
  answers.length = 0;
  await collectContacts(db, {
    fetch: async () => [cq(31, '222', 'take:1'), cq(32, '222', 'taken:1')],
    send: async () => {}, answer: async (id, o) => answers.push(o), editMarkup: async () => {},
  });
  assert.match(answers[0].text, /Уже взял\(а\) Бехруз Тамиров/);
  assert.equal(answers[0].alert, true);
  assert.match(answers[1].text, /Уже в работе у Бехруз/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tg_outbox WHERE kind = 'taken'").get().c, 1);
  assert.equal(db.prepare('SELECT last_update_id FROM tg_state').get().last_update_id, 32);
});

test('уведомление о назначении после взятия сразу идёт с погашенной кнопкой', async () => {
  const db = setup();
  teamOfThree(db);
  takeLead(db, 1, '111');
  enqueueAssignment(db, 1, 1);
  const sent = [];
  await flushNotifications(db, { send: async (chat, text, opts) => { sent.push({ chat, kb: opts.replyMarkup }); return {}; } });
  const assign = sent.filter((x) => x.kb);
  assert.equal(assign.length, 2, 'назначение ушло обоим, раннее «взято» его не гасит');
  assert.match(assign[0].kb.inline_keyboard.at(-1)[0].text, /В работе: Бехруз/);
});

test('кнопка с мусорными данными не ломает обработку', () => {
  const db = setup();
  assert.deepEqual(handleCallback(db, { chatId: '1', data: 'drop table' }), { answer: null });
  assert.equal(buildTakenText({ company: 'A<B' }, { name: null, taken_at: '2026-09-18 06:34:00' }).includes('A&lt;B'), true);
});
