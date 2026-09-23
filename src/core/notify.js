// Уведомления команде о назначении: получателю и всем, кто в списке уведомлений.
// Пишем в очередь, отправляет воркер — телеграм может лежать, раздача от этого не встаёт.
import { sendMessage, getUpdates, answerCallback, editReplyMarkup } from '../adapters/telegram.js';
import { logTeamChange } from './teams.js';
import { logEvent } from './queue.js';
import { handleTransferText, transferKeyboard } from './transfer.js';

const BACKOFF_SEC = [0, 30, 120, 600, 3600];
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const plus = (sec) => new Date(Date.now() + sec * 1000).toISOString().slice(0, 19).replace('T', ' ');

const KIND_LABEL = { lead: 'Лид', meeting: 'Встреча' };

const escape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Ссылки на карточки. Шаблоны в .env, чтобы смена адресов не лезла в код. */
export function companyLinks(lead) {
  const links = [];
  const argusTpl = process.env.ARGUS_COMPANY_URL;
  const b24Tpl = process.env.B24_COMPANY_URL;
  if (argusTpl && lead.argus_company_id) {
    links.push(`<a href="${argusTpl.replace('{id}', lead.argus_company_id)}">Карточка в Аргусе</a>`);
  }
  if (b24Tpl && lead.b24_company_id) {
    links.push(`<a href="${b24Tpl.replace('{id}', lead.b24_company_id)}">Карточка в Б24</a>`);
  }
  return links;
}

export function buildText(lead, team, { forAssignee }) {
  const head = forAssignee
    ? `🎯 <b>Вам назначено: ${KIND_LABEL[lead.kind] || lead.kind}</b>`
    : `📣 <b>${KIND_LABEL[lead.kind] || lead.kind} в вашу команду</b>`;

  const lines = [head, '', `<b>${escape(lead.company)}</b>`];
  if (lead.lead_gen) lines.push(`Лидоген: ${escape(lead.lead_gen)}`);
  lines.push(`Команда: ${escape(team.name)}`);
  if (!forAssignee) lines.push('Назначено на ответственного команды, вы — для информации.');

  const links = companyLinks(lead);
  if (links.length) lines.push('', links.join(' · '));
  return lines.join('\n');
}

/**
 * Кнопка «Оставить фидбэк» под уведомлением: открывает мини-апп с уже
 * подставленной компанией. Без MINIAPP_URL кнопки просто нет — текст уходит как раньше.
 */
export function feedbackButton(leadId, { base = process.env.MINIAPP_URL } = {}) {
  if (!base || !leadId) return undefined;
  const url = `${String(base).replace(/\/$/, '')}/feedback.html?lead=${leadId}`;
  return { inline_keyboard: [[{ text: '💬 Оставить фидбэк', web_app: { url } }]] };
}

/**
 * Кнопки под уведомлением о назначении: фидбэк и «Взял в работу».
 * Когда компанию уже взяли — вместо кнопки подпись, кто взял: нажать второй раз нельзя.
 */
export function assignmentButtons(leadId, { take = null, base = process.env.MINIAPP_URL } = {}) {
  if (!leadId) return undefined;
  const rows = [];
  const fb = feedbackButton(leadId, { base });
  if (fb) rows.push(fb.inline_keyboard[0]);
  rows.push([take
    ? { text: `✅ В работе: ${take.name || 'взято'}`, callback_data: `taken:${leadId}` }
    : { text: '✅ Взял в работу', callback_data: `take:${leadId}` }]);
  return { inline_keyboard: rows };
}

const TZ = process.env.DISPLAY_TZ || 'Asia/Tashkent';
/** «11:34 18.09» по времени Ташкента: людям в уведомлении нужно местное, а не UTC базы. */
export function fmtTime(iso) {
  const d = iso ? new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z')) : new Date();
  const p = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
    .formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.hour}:${p.minute} ${p.day}.${p.month}`;
}

export function buildTakenText(lead, take) {
  return [
    '✅ <b>Взято в работу</b>',
    '',
    `<b>${escape(lead.company)}</b>`,
    `${escape(take.name || 'Участник команды')} взял(а) в работу в ${fmtTime(take.taken_at)}`,
  ].join('\n');
}

/**
 * Нажали «Взял в работу». Взять может любой активный участник команды, которой
 * назначена компания. Остальным участникам уходит уведомление с цитатой их
 * исходного сообщения о назначении — видно, о какой компании речь, без поиска по чату.
 */
export function takeLead(db, leadId, chatId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return { ok: false, reason: 'not_found' };

  const existing = db.prepare('SELECT * FROM lead_takes WHERE lead_id = ?').get(leadId);
  if (existing) return { ok: false, reason: 'taken', take: existing };

  const member = lead.assigned_team ? db.prepare(
    'SELECT * FROM team_members WHERE team_id = ? AND telegram_chat_id = ? AND active = 1 ORDER BY id LIMIT 1'
  ).get(lead.assigned_team, String(chatId)) : null;
  if (!member) return { ok: false, reason: 'not_member' };

  const name = member.name || member.argus_user_id;
  db.prepare('INSERT INTO lead_takes (lead_id, team_id, member_id, chat_id, name) VALUES (?, ?, ?, ?, ?)')
    .run(leadId, lead.assigned_team, member.id, String(chatId), name);
  const take = db.prepare('SELECT * FROM lead_takes WHERE lead_id = ?').get(leadId);
  logEvent(db, { leadId, teamId: lead.assigned_team, kind: 'taken', data: { by: member.argus_user_id, name } });

  const others = db.prepare(
    'SELECT * FROM team_members WHERE team_id = ? AND active = 1 AND id != ? AND telegram_chat_id IS NOT NULL ORDER BY id'
  ).all(lead.assigned_team, member.id);
  const text = buildTakenText(lead, take);
  let queued = 0;
  for (const m of others) {
    const exists = db.prepare("SELECT 1 FROM tg_outbox WHERE lead_id = ? AND member_id = ? AND kind = 'taken'").get(leadId, m.id);
    if (exists) continue;
    // Цитируем то самое уведомление о назначении, которое пришло этому человеку.
    const origin = db.prepare(
      "SELECT message_id FROM tg_outbox WHERE lead_id = ? AND member_id = ? AND kind = 'assign' AND state = 'sent' AND message_id IS NOT NULL LIMIT 1"
    ).get(leadId, m.id);
    db.prepare(
      "INSERT INTO tg_outbox (lead_id, team_id, member_id, chat_id, text, kind, reply_to) VALUES (?, ?, ?, ?, ?, 'taken', ?)"
    ).run(leadId, lead.assigned_team, m.id, String(m.telegram_chat_id), text, origin?.message_id ?? null);
    queued++;
  }
  return { ok: true, take, queued };
}

/** Уведомления о назначении, которые уже ушли людям, — чтобы погасить у них кнопку «Взял». */
export const sentAssignments = (db, leadId) => db.prepare(
  "SELECT chat_id, message_id FROM tg_outbox WHERE lead_id = ? AND kind = 'assign' AND state = 'sent' AND message_id IS NOT NULL"
).all(leadId);

/** Что ответить на нажатие кнопки и как поменять кнопки: чистая функция, чтобы тестировать без сети. */
export function handleCallback(db, { chatId, data }) {
  const m = /^(take|taken):(\d+)$/.exec(String(data || ''));
  if (!m) return { answer: null };
  const leadId = Number(m[2]);
  if (m[1] === 'taken') {
    const take = db.prepare('SELECT * FROM lead_takes WHERE lead_id = ?').get(leadId);
    return { answer: take ? `Уже в работе у ${take.name} с ${fmtTime(take.taken_at)}` : 'Компания ещё не взята', alert: false };
  }
  const res = takeLead(db, leadId, chatId);
  if (res.ok) return { answer: 'Взято в работу. Команде сообщил.', alert: false, take: res.take, leadId, queued: res.queued };
  if (res.reason === 'taken') return { answer: `Уже взял(а) ${res.take.name} в ${fmtTime(res.take.taken_at)}`, alert: true, take: res.take, leadId };
  if (res.reason === 'not_member') return { answer: 'Вы не в команде, которой назначена эта компания.', alert: true };
  return { answer: 'Компания не найдена.', alert: true };
}

/**
 * Поставить уведомления в очередь: получателю — «вам назначено», остальным активным — к сведению.
 * Повторно по той же строке и тому же человеку не ставим: воркер мог только упасть, а не задвоить.
 */
export function enqueueAssignment(db, leadId, teamId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!lead || !team) return { queued: 0, skipped: 0 };

  const members = db.prepare(
    'SELECT * FROM team_members WHERE team_id = ? AND active = 1 ORDER BY id'
  ).all(teamId);

  let queued = 0, skipped = 0;
  for (const member of members) {
    if (!member.telegram_chat_id) { skipped++; continue; }
    const exists = db.prepare(
      "SELECT 1 FROM tg_outbox WHERE lead_id = ? AND member_id = ? AND kind = 'assign'"
    ).get(leadId, member.id);
    if (exists) continue;

    db.prepare(
      'INSERT INTO tg_outbox (lead_id, team_id, member_id, chat_id, text) VALUES (?, ?, ?, ?, ?)'
    ).run(leadId, teamId, member.id, String(member.telegram_chat_id),
      buildText(lead, team, { forAssignee: member.role === 'assignee' }));
    queued++;
  }
  return { queued, skipped };
}

/**
 * Компания уже ведётся в Аргусе — сигнал руководителю команды того, кто её ведёт.
 * Назначения не было, поэтому это не «вам назначено», а просьба разобраться,
 * почему своя компания оказалась в лидогенерации.
 */
export function buildDuplicateText(lead, { teamName, responsible, argusTitle }) {
  const lines = [
    '⚠️ <b>Компания уже ведётся в Аргусе</b>',
    '',
    `<b>${escape(argusTitle || lead.company)}</b>`,
  ];
  if (lead.lead_gen) lines.push(`Лидоген: ${escape(lead.lead_gen)}`);
  if (teamName) lines.push(`Пришла как ${KIND_LABEL[lead.kind] || lead.kind} в команду: ${escape(teamName)}`);
  if (responsible) lines.push(`Ответственный в Аргусе: ${escape(responsible)}`);
  lines.push('', 'Назначение не делали и карточку не трогали. Ход команде не засчитан — '
    + 'строка помечена как фрод. Нужно проверить, почему эта компания попала в лидогенерацию.');

  const links = companyLinks(lead);
  if (links.length) lines.push('', links.join(' · '));
  return lines.join('\n');
}

/**
 * Кому уходит такой сигнал: руководителю команды, где числится ответственный
 * (участник с ролью assignee), иначе — самому ответственному, если он у нас есть.
 * Никого не нашли — резервный чат из DUPLICATE_ALERT_CHAT_ID, чтобы сигнал не пропал.
 */
export function duplicateRecipients(db, responsible) {
  const owner = responsible ? db.prepare(`
    SELECT m.*, t.name team_name FROM team_members m JOIN teams t ON t.id = m.team_id
    WHERE lower(trim(m.argus_user_id)) = lower(?) AND m.active = 1 LIMIT 1`).get(String(responsible).trim()) : null;

  if (owner) {
    const head = db.prepare(`
      SELECT m.*, t.name team_name FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.team_id = ? AND m.role = 'assignee' AND m.active = 1 ORDER BY m.id LIMIT 1`).get(owner.team_id);
    // Руководителя нет в телеграме — лучше написать самому ответственному, чем молчать.
    const target = [head, owner].find((m) => m?.telegram_chat_id);
    if (target) return [target];
  }
  const fallback = process.env.DUPLICATE_ALERT_CHAT_ID;
  return fallback ? [{ id: null, telegram_chat_id: fallback, team_id: null, team_name: null }] : [];
}

/** Поставить сигнал о дубле в очередь. Повтор по той же строке и чату не плодим. */
export function enqueueDuplicateAlert(db, leadId, teamId, { responsible = null, argusTitle = null } = {}) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return { queued: 0, skipped: 0 };
  const team = teamId ? db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) : null;

  const targets = duplicateRecipients(db, responsible);
  if (!targets.length) return { queued: 0, skipped: 1, reason: 'некому отправить: ответственный не найден в командах' };

  const text = buildDuplicateText(lead, { teamName: team?.name || null, responsible, argusTitle });
  let queued = 0;
  for (const target of targets) {
    const exists = db.prepare(
      'SELECT 1 FROM tg_outbox WHERE lead_id = ? AND chat_id = ? AND text = ?'
    ).get(leadId, String(target.telegram_chat_id), text);
    if (exists) continue;
    // member_id намеренно пустой: по нему enqueueAssignment ищет свои дубли,
    // и сигнал о чужой компании не должен гасить будущее уведомление о назначении.
    db.prepare('INSERT INTO tg_outbox (lead_id, team_id, member_id, chat_id, text) VALUES (?, ?, NULL, ?, ?)')
      .run(leadId, target.team_id ?? null, String(target.telegram_chat_id), text);
    queued++;
  }
  return { queued, skipped: 0 };
}

/** Один проход воркера уведомлений. */
export async function flushNotifications(db, { limit = 20, send = sendMessage } = {}) {
  const rows = db.prepare(
    "SELECT * FROM tg_outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?"
  ).all(nowIso(), limit);
  if (!rows.length) return { picked: 0, sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  for (const row of rows) {
    const attempts = row.attempts + 1;
    try {
      // Кнопки — только под уведомлением о назначении участнику команды. Сигнал о чужой
      // компании (member_id пустой) и «взято в работу» уходят без них.
      const take = row.member_id && row.kind === 'assign'
        ? db.prepare('SELECT * FROM lead_takes WHERE lead_id = ?').get(row.lead_id) : null;
      const result = await send(row.chat_id, row.text, {
        replyMarkup: row.member_id && row.kind === 'assign' ? assignmentButtons(row.lead_id, { take }) : undefined,
        replyTo: row.reply_to || undefined,
      });
      db.prepare("UPDATE tg_outbox SET state = 'sent', attempts = ?, sent_at = ?, last_error = NULL, message_id = ? WHERE id = ?")
        .run(attempts, nowIso(), result?.message_id != null ? String(result.message_id) : null, row.id);
      sent++;
    } catch (err) {
      failed++;
      const message = String(err.message || err);
      // 403 — человек не нажал «Старт» у бота. Повторы не помогут, ждём привязки.
      const fatal = err.code === 403 || err.code === 400 || attempts >= BACKOFF_SEC.length;
      db.prepare(`UPDATE tg_outbox SET attempts = ?, last_error = ?, state = ?, next_attempt_at = ? WHERE id = ?`)
        .run(attempts, message, fatal ? 'failed' : 'pending',
          plus(BACKOFF_SEC[Math.min(attempts, BACKOFF_SEC.length - 1)]), row.id);
    }
  }
  return { picked: rows.length, sent, failed };
}

const ASK_LOGIN = 'Здравствуйте! Это бот уведомлений по лидам.\n\n'
  + 'Пришлите одним сообщением ваш ID в Аргусе — он на вашей странице сотрудника, '
  + 'рядом есть кнопка «скопировать». Выглядит как короткое имя (например tagirsol) '
  + 'или длинный код через дефисы.\n\n'
  + 'Пароль и почту присылать не нужно.';
const BOUND = (name, team) => `Готово, ${name}. Вы в команде «${team}».\n`
  + 'Сюда будут приходить компании, назначенные команде, со ссылками на карточки.';
const SELF_BOUND = (login) => `Готово, ID <b>${login}</b> привязан.\n`
  + 'Чтобы перенести компанию из Б24 в Аргус: /transfer и пришлите ссылку на карточку.';
const HELLO_BOUND = 'Вы привязаны. Кнопка «Перенос в Аргус» внизу: вставьте ссылку на компанию Б24 — она заведётся в Аргусе на вас.';
const isBound = (db, chatId) => !!db.prepare('SELECT 1 FROM team_members WHERE telegram_chat_id = ? AND active = 1').get(String(chatId));
const NOT_FOUND = 'Это не похоже на ID Аргуса.\n\n'
  + 'Нужен именно ID сотрудника из Аргуса — не почта и не пароль. '
  + 'Откройте свою страницу сотрудника в Аргусе и скопируйте ID кнопкой.\n'
  + 'Если ID верный — напишите руководителю, возможно вас ещё не добавили в команду.';
const TG_ID_SENT = 'Это ваш ID в телеграме, а нужен ID в Аргусе.\n\n'
  + 'Откройте свою страницу сотрудника в Аргусе и скопируйте ID кнопкой — и пришлите его сюда.';

/**
 * Человек прислал логин Аргуса — привязываем его чат к участнику команды.
 * Так руководителю не нужно вручную переносить chat id из списка в карточку.
 */
export const LIDGEN_TEAM = 'Лидгены';
/** Служебная команда лидгенов: не в очереди (active=0), лидов не получает. Создаётся при первом обращении. */
export function lidgenTeam(db) {
  const row = db.prepare('SELECT id FROM teams WHERE name = ?').get(LIDGEN_TEAM);
  if (row) return row.id;
  const info = db.prepare('INSERT INTO teams (name, queue_order, active) VALUES (?, 99, 0)').run(LIDGEN_TEAM);
  const id = Number(info.lastInsertRowid);
  logTeamChange(db, id, 'team_created', { name: LIDGEN_TEAM, queue_order: 99, active: 0, by: 'бот' });
  return id;
}
// ID Аргуса — короткое имя латиницей/цифрами или код через дефисы; русский текст и ссылки — нет.
const looksLikeArgusId = (s) => /^[a-z0-9][a-z0-9._-]{1,63}$/i.test(s);

export function bindByLogin(db, chatId, text) {
  const login = String(text ?? '').trim();
  if (!login || login.startsWith('/')) return null;

  const member = db.prepare(`
    SELECT m.*, t.name team_name FROM team_members m JOIN teams t ON t.id = m.team_id
    WHERE lower(trim(m.argus_user_id)) = lower(?) LIMIT 1`).get(login);
  // Незнакомый ID — это лидген: их в Аргусе завели, а в команды не вписывают.
  // Вписываем сами в служебную команду «Лидгены» — вне очереди, без назначений,
  // но с правом переносить компании (/transfer). Опечатку в ID выявит первый же
  // перенос: Аргус не примет ответственного, бот ответит ошибкой.
  if (!member) {
    if (!looksLikeArgusId(login)) return { ok: false };
    // Частая путаница: присылают свой телеграмный ID вместо аргусовского.
    if (login === String(chatId)) return { ok: false, tgId: true };
    const teamId = lidgenTeam(db);
    // Прошлая самопривязка этого чата могла быть с опечаткой — гасим её,
    // иначе перенос уйдёт по старому ID и Аргус снова скажет «такого сотрудника нет».
    db.prepare(`UPDATE team_members SET active = 0, updated_at = datetime('now')
      WHERE telegram_chat_id = ? AND team_id = ? AND active = 1`).run(String(chatId), teamId);
    const info = db.prepare(`INSERT INTO team_members (team_id, argus_user_id, role, telegram_chat_id)
      VALUES (?, ?, 'notify', ?)`).run(teamId, login, String(chatId));
    logTeamChange(db, teamId, 'member_added', { argus_user_id: login, telegram_bound: String(chatId), by: 'сам через бота' });
    const created = db.prepare('SELECT m.*, t.name team_name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.id = ?')
      .get(Number(info.lastInsertRowid));
    return { ok: true, member: created, self: true };
  }

  db.prepare("UPDATE team_members SET telegram_chat_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(String(chatId), member.id);
  logTeamChange(db, member.team_id, 'member_changed', {
    argus_user_id: member.argus_user_id, telegram_bound: String(chatId), by: 'сам через бота',
  });
  return { ok: true, member };
}

/**
 * Забрать новые сообщения боту, запомнить, кто написал, и поздороваться.
 * Копим у себя, потому что телеграм держит непрочитанное только сутки:
 * человек нажал «Старт» в пятницу — в понедельник его уже не найти.
 */
export async function collectContacts(db, {
  fetch: fetchUpdates = getUpdates, send = sendMessage, answer = answerCallback, editMarkup = editReplyMarkup,
  transfer = {},
} = {}) {
  const state = db.prepare('SELECT last_update_id FROM tg_state WHERE id = 1').get();
  const updates = await fetchUpdates((state?.last_update_id || 0) + 1);
  if (!updates.length) return { seen: 0, added: 0, taken: 0 };

  let added = 0, taken = 0, maxId = state?.last_update_id || 0;
  for (const u of updates) {
    maxId = Math.max(maxId, u.update_id || 0);
    if (u.callback_query) {
      taken += await onCallback(db, u.callback_query, { answer, editMarkup });
      continue;
    }
    const from = u.message?.from || u.my_chat_member?.from;
    const chat = u.message?.chat || u.my_chat_member?.chat;
    if (!from || !chat || from.is_bot) continue;

    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
    const known = db.prepare('SELECT 1 FROM tg_contacts WHERE chat_id = ?').get(String(chat.id));
    db.prepare(`INSERT INTO tg_contacts (chat_id, name, username) VALUES (?, ?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name,
                  username = excluded.username, last_seen = datetime('now')`)
      .run(String(chat.id), name, from.username || null);

    const text = u.message?.text || '';
    if (!known) added++;
    // Перенос компании из Б24: команда или ссылка на карточку. Ответ не гасим
    // как повтор — каждая ссылка даёт свой результат.
    const moved = await handleTransferText(db, chat.id, text, transfer);
    if (moved.handled) {
      try { await send(String(chat.id), moved.reply, { replyMarkup: transferKeyboard() }); } catch { /* заблокировал бота — не беда */ }
      continue;
    }
    const reply = answerFor(db, chat.id, text, known);
    // Повтор гасим по времени, а не навсегда: стена одинаковых сообщений плоха,
    // но полное молчание человек читает как «бот сломался».
    if (reply && !justSaid(db, chat.id, reply)) {
      // Кнопка «Перенос в Аргус» едет с каждым ответом бота: у кого её ещё нет — появится.
      try { await send(String(chat.id), reply, { replyMarkup: transferKeyboard() }); } catch { /* заблокировал бота — не беда */ }
      rememberReply(db, chat.id, reply);
    }
  }
  db.prepare('UPDATE tg_state SET last_update_id = ? WHERE id = 1').run(maxId);
  return { seen: updates.length, added, taken };
}

/** Нажатие кнопки: записать, ответить нажавшему, погасить кнопку у всех, кому уходило назначение. */
async function onCallback(db, cq, { answer, editMarkup }) {
  const chatId = String(cq.message?.chat?.id ?? cq.from?.id ?? '');
  const res = handleCallback(db, { chatId, data: cq.data });
  if (res.answer) {
    try { await answer(cq.id, { text: res.answer, alert: res.alert }); } catch { /* ответ на кнопку не критичен */ }
  }
  if (!res.take) return 0;
  // Кнопки меняем у всех: кто бы ни открыл своё уведомление, увидит, что компания уже в работе.
  const markup = assignmentButtons(res.leadId, { take: res.take });
  for (const row of sentAssignments(db, res.leadId)) {
    try { await editMarkup(row.chat_id, row.message_id, markup); } catch { /* сообщение могли удалить */ }
  }
  return res.queued ? 1 : 0;
}

const REPEAT_SILENCE_SEC = 60;

/** Тот же ответ этому человеку меньше минуты назад — молчим. */
function justSaid(db, chatId, reply, nowMs = Date.now()) {
  const row = db.prepare('SELECT last_reply, last_reply_at FROM tg_contacts WHERE chat_id = ?').get(String(chatId));
  if (!row || row.last_reply !== reply || !row.last_reply_at) return false;
  return (nowMs - Date.parse(row.last_reply_at + 'Z')) < REPEAT_SILENCE_SEC * 1000;
}

const rememberReply = (db, chatId, reply) =>
  db.prepare("UPDATE tg_contacts SET last_reply = ?, last_reply_at = datetime('now') WHERE chat_id = ?")
    .run(reply, String(chatId));

// Что ответить человеку: просим ID, а на верный ID — подтверждаем команду.
function answerFor(db, chatId, text, known) {
  const clean = String(text || '').trim();
  if (!clean || clean.startsWith('/')) {
    if (!known) return ASK_LOGIN;
    // Привязанному на «Старт» — подсказка с кнопкой, а не молчание.
    return clean.startsWith('/start') && isBound(db, chatId) ? HELLO_BOUND : null;
  }

  const bound = bindByLogin(db, chatId, clean);
  if (!bound) return null;
  if (!bound.ok) return bound.tgId ? TG_ID_SENT : NOT_FOUND;
  if (bound.self) return SELF_BOUND(bound.member.argus_user_id);
  return BOUND(bound.member.name || bound.member.argus_user_id, bound.member.team_name);
}

/** Кто написал боту и ещё не привязан ни к кому. */
export function knownContacts(db) {
  return db.prepare(`
    SELECT c.*, (
      SELECT m.name FROM team_members m WHERE m.telegram_chat_id = c.chat_id LIMIT 1
    ) AS bound_to
    FROM tg_contacts c ORDER BY c.last_seen DESC`).all();
}
