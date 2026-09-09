import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openMigrated } from '../src/db/index.js';
import { addMember } from '../src/core/teams.js';
import { verifyInitData, identify, leadContext, addFeedback, listFeedback, getFeedback } from '../src/core/feedback.js';
import { feedbackButton } from '../src/core/notify.js';

const TOKEN = '123456:TEST-TOKEN';

/** Собрать initData так, как его подписывает телеграм. */
function initData(user, { token = TOKEN, authDate = Math.floor(Date.now() / 1000) } = {}) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

function setup() {
  const db = openMigrated(':memory:');
  db.prepare('INSERT INTO teams (id, name, queue_order) VALUES (1, ?, 1)').run('МА');
  db.prepare(`INSERT INTO leads (id, source_key, source_hash, company, kind, lead_gen, assigned_team)
              VALUES (1, 'Лист1:3', 'h', 'BIZOAT NEFT', 'lead', 'Тагир', 1)`).run();
  addMember(db, 1, { argus_user_id: 'kostya', name: 'Константин Ю', role: 'assignee', telegram_chat_id: '555' });
  return db;
}

const USER = { id: 555, first_name: 'Константин' };

test('подпись телеграма проверяется: своё принимаем, чужое отбиваем', () => {
  assert.equal(verifyInitData(initData(USER), { token: TOKEN }).id, 555);
  assert.equal(verifyInitData(initData(USER, { token: 'чужой-токен' }), { token: TOKEN }), null,
    'подписано не нашим ботом — автор недоказуем');
  const tampered = new URLSearchParams(initData(USER));
  tampered.set('user', JSON.stringify({ ...USER, id: 999 }));
  assert.equal(verifyInitData(tampered.toString(), { token: TOKEN }), null,
    'подменили пользователя — подпись перестаёт сходиться');
  assert.equal(verifyInitData('user=%7B%22id%22%3A555%7D&auth_date=1', { token: TOKEN }), null,
    'без hash не пускаем');
});

test('просроченная подпись не пускает: скриншот ссылки — не живое окно', () => {
  const old = initData(USER, { authDate: Math.floor(Date.now() / 1000) - 25 * 3600 });
  assert.equal(verifyInitData(old, { token: TOKEN }), null);
});

test('фидбэк принимаем только от человека из команды', () => {
  const db = setup();
  assert.equal(identify(db, { id: 777 }), null, 'посторонний телеграм — не наш автор');
  const who = identify(db, USER);
  assert.equal(who.member.team_id, 1);
  assert.equal(who.name, 'Константин Ю');
});

test('фидбэк по лиду и свободный ложатся в одну таблицу', () => {
  const db = setup();
  const who = identify(db, USER);

  addFeedback(db, { who, leadId: 1, text: 'Контакт нерелевантный, у них нет своего транспорта' });
  addFeedback(db, { who, text: 'В таблице стоит просить ИНН — без него карточка пустая' });

  const list = listFeedback(db);
  assert.equal(list.length, 2);
  assert.equal(list[0].lead_id, null, 'свободный фидбэк живёт без компании');
  assert.equal(list[1].company, 'BIZOAT NEFT', 'привязанный подтягивает название');
  assert.equal(list[1].team_name, 'МА');
  assert.equal(list[0].author, 'Константин Ю');
});

test('пустой текст не сохраняем', () => {
  const db = setup();
  const who = identify(db, USER);
  assert.throws(() => addFeedback(db, { who, text: '   ' }), /пустой/);
  assert.equal(listFeedback(db).length, 0);
});

test('несуществующий лид не роняет отправку — пишем без привязки', () => {
  const db = setup();
  const who = identify(db, USER);
  assert.equal(leadContext(db, 4242), null);
  assert.equal(addFeedback(db, { who, leadId: 4242, text: 'что-то по памяти' }).lead_id, null);
});

test('кнопка под уведомлением ведёт в мини-апп с этой компанией', () => {
  const markup = feedbackButton(7, { base: 'https://lidgen.at-km.net/' });
  assert.equal(markup.inline_keyboard[0][0].web_app.url, 'https://lidgen.at-km.net/feedback.html?lead=7');
  assert.equal(feedbackButton(7, { base: '' }), undefined, 'без MINIAPP_URL кнопки нет');
  assert.equal(feedbackButton(null, { base: 'https://x' }), undefined);
});

test('карточка фидбэка несёт ссылки на компанию в Б24 и Аргусе', () => {
  const db = setup();
  db.prepare("UPDATE leads SET b24_company_id = '3094401', argus_company_id = 'arg-77' WHERE id = 1").run();
  const who = identify(db, USER);
  const { id } = addFeedback(db, { who, leadId: 1, text: 'клиент просил созвон после 10-го' });

  process.env.B24_COMPANY_URL = 'https://acrm.site/crm/company/details/{id}/';
  process.env.ARGUS_COMPANY_URL = 'https://crm-mvp.cloudplus.uz/companies/{id}';
  const card = getFeedback(db, id);
  assert.equal(card.b24_url, 'https://acrm.site/crm/company/details/3094401/');
  assert.equal(card.argus_url, 'https://crm-mvp.cloudplus.uz/companies/arg-77');
  assert.equal(card.company, 'BIZOAT NEFT');

  // свободный фидбэк ссылок не получает — компании нет
  const free = getFeedback(db, addFeedback(db, { who, text: 'общее замечание' }).id);
  assert.equal(free.b24_url, null);
  assert.equal(free.argus_url, null);
});

test('фидбэка с таким номером нет — карточка не выдумывается', () => {
  assert.equal(getFeedback(setup(), 999), null);
});

test('компанию узнаём по ссылке в тексте свободного фидбэка', () => {
  const db = setup();
  db.prepare("UPDATE leads SET b24_company_id = '3094401', argus_company_id = 'arg-77' WHERE id = 1").run();
  process.env.B24_COMPANY_URL = 'https://acrm.site/crm/company/details/{id}/';
  process.env.ARGUS_COMPANY_URL = 'https://crm-mvp.cloudplus.uz/companies/{id}';

  const who = identify(db, USER);
  const { id } = addFeedback(db, { who, text:
    '1. Лидген говорит что сделаем ERP за 2 недели - https://acrm.site/crm/company/details/3094401/\n'
    + '2. Обещает демо на встрече - https://acrm.site/crm/company/details/3109475/' });

  const card = getFeedback(db, id);
  assert.equal(card.lead_id, null, 'фидбэк свободный, привязки к строке нет');
  assert.equal(card.mentions.length, 2);

  const known = card.mentions[0];
  assert.equal(known.company, 'BIZOAT NEFT', 'свою компанию узнали по номеру из ссылки');
  assert.equal(known.lead_gen, 'Тагир', 'автор лида подтянулся');
  assert.equal(known.team_name, 'МА');
  assert.equal(known.argus_url, 'https://crm-mvp.cloudplus.uz/companies/arg-77');

  const unknown = card.mentions[1];
  assert.equal(unknown.company, null, 'чужой компании у нас нет — так и говорим');
  assert.equal(unknown.ref, '3109475');
  assert.equal(unknown.b24_url, 'https://acrm.site/crm/company/details/3109475/',
    'ссылку всё равно отдаём: открыть карточку можно');
});

test('в привязанном фидбэке та же компания вторым списком не дублируется', () => {
  const db = setup();
  db.prepare("UPDATE leads SET b24_company_id = '3094401' WHERE id = 1").run();
  process.env.B24_COMPANY_URL = 'https://acrm.site/crm/company/details/{id}/';
  const who = identify(db, USER);
  const { id } = addFeedback(db, { who, leadId: 1,
    text: 'см. https://acrm.site/crm/company/details/3094401/' });
  assert.deepEqual(getFeedback(db, id).mentions, []);
});

test('одна и та же ссылка дважды — одна строка', () => {
  const db = setup();
  process.env.B24_COMPANY_URL = 'https://acrm.site/crm/company/details/{id}/';
  const who = identify(db, USER);
  const { id } = addFeedback(db, { who,
    text: 'https://acrm.site/crm/company/details/999/ и снова https://acrm.site/crm/company/details/999/' });
  assert.equal(getFeedback(db, id).mentions.length, 1);
});
