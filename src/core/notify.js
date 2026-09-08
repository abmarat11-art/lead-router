// Уведомления команде о назначении: получателю и всем, кто в списке уведомлений.
// Пишем в очередь, отправляет воркер — телеграм может лежать, раздача от этого не встаёт.
import { sendMessage, getUpdates } from '../adapters/telegram.js';

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
      'SELECT 1 FROM tg_outbox WHERE lead_id = ? AND member_id = ?'
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
      await send(row.chat_id, row.text);
      db.prepare("UPDATE tg_outbox SET state = 'sent', attempts = ?, sent_at = ?, last_error = NULL WHERE id = ?")
        .run(attempts, nowIso(), row.id);
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

const GREETING = 'Готово — вы подписаны на уведомления по лидам.\n'
  + 'Сюда будут приходить компании, назначенные вашей команде, со ссылками на карточки.';

/**
 * Забрать новые сообщения боту, запомнить, кто написал, и поздороваться.
 * Копим у себя, потому что телеграм держит непрочитанное только сутки:
 * человек нажал «Старт» в пятницу — в понедельник его уже не найти.
 */
export async function collectContacts(db, { fetch: fetchUpdates = getUpdates, send = sendMessage } = {}) {
  const state = db.prepare('SELECT last_update_id FROM tg_state WHERE id = 1').get();
  const updates = await fetchUpdates((state?.last_update_id || 0) + 1);
  if (!updates.length) return { seen: 0, added: 0 };

  let added = 0, maxId = state?.last_update_id || 0;
  for (const u of updates) {
    maxId = Math.max(maxId, u.update_id || 0);
    const from = u.message?.from || u.my_chat_member?.from;
    const chat = u.message?.chat || u.my_chat_member?.chat;
    if (!from || !chat || from.is_bot) continue;

    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
    const known = db.prepare('SELECT 1 FROM tg_contacts WHERE chat_id = ?').get(String(chat.id));
    db.prepare(`INSERT INTO tg_contacts (chat_id, name, username) VALUES (?, ?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name,
                  username = excluded.username, last_seen = datetime('now')`)
      .run(String(chat.id), name, from.username || null);

    // Здороваемся один раз: человек должен понимать, что нажатие сработало.
    if (!known) {
      added++;
      try { await send(String(chat.id), GREETING); } catch { /* заблокировал бота — не беда */ }
    }
  }
  db.prepare('UPDATE tg_state SET last_update_id = ? WHERE id = 1').run(maxId);
  return { seen: updates.length, added };
}

/** Кто написал боту и ещё не привязан ни к кому. */
export function knownContacts(db) {
  return db.prepare(`
    SELECT c.*, (
      SELECT m.name FROM team_members m WHERE m.telegram_chat_id = c.chat_id LIMIT 1
    ) AS bound_to
    FROM tg_contacts c ORDER BY c.last_seen DESC`).all();
}
