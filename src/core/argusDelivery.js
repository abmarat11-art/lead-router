import { enqueueAssignment } from './notify.js';
// Компания уехала в Аргус уже назначенной: заводим её на ответственного той команды,
// которой очередь отдала строку, и сразу указываем тип — лид или встреча.
// Компания с таким ИНН уже есть — берём её, дубль не плодим.
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const MAX_ATTEMPTS = 5;

function logEvent(db, leadId, teamId, kind, data = {}) {
  db.prepare('INSERT INTO events (lead_id, team_id, kind, data) VALUES (?, ?, ?, ?)')
    .run(leadId, teamId, kind, JSON.stringify(data));
}

/** Назначенные строки, которые ещё не уехали в СРМ. */
export function pending(db, limit = 20) {
  return db.prepare(`
    SELECT l.*, t.name team_name,
      COALESCE(
        (SELECT m.argus_user_id FROM team_members m
          WHERE m.team_id = t.id AND m.role = 'assignee' AND m.active = 1 ORDER BY m.id LIMIT 1),
        t.argus_user_id
      ) AS argus_user_id
    FROM leads l JOIN teams t ON t.id = l.assigned_team
    -- Фрод и карантин в СРМ не заводим: компания закрыта, ход был потрачен впустую.
    WHERE l.argus_state = 'pending' AND l.argus_attempts < ?
      AND l.status IN ('assigned', 'in_work')
    ORDER BY l.id LIMIT ?`).all(MAX_ATTEMPTS, limit);
}

/**
 * Вернуть в очередь доставки строки команды, упавшие из-за ненастроенного получателя.
 * Иначе они молча остаются в failed: команду заполнили, а компании так и не уехали.
 */
export function retryTeam(db, teamId) {
  const info = db.prepare(`
    UPDATE leads SET argus_state = 'pending', argus_attempts = 0, argus_error = NULL, updated_at = ?
    WHERE assigned_team = ? AND argus_state = 'failed'`).run(nowIso(), teamId);
  const revived = Number(info.changes || 0);
  if (revived) logEvent(db, null, teamId, 'argus_retry_team', { revived });
  return { revived };
}

/**
 * Один проход доставки.
 * @param {{ensure?: Function}} deps подменяется в тестах
 */
export async function deliverPending(db, { limit = 20, ensure } = {}) {
  const rows = pending(db, limit);
  if (!rows.length) return { picked: 0, sent: 0, failed: 0 };

  const ensureCompany = ensure || (await import('../adapters/argus.js')).ensureCompany;

  let sent = 0, failed = 0;
  for (const lead of rows) {
    const attempts = lead.argus_attempts + 1;
    try {
      if (!lead.argus_user_id) {
        throw new Error(`у команды «${lead.team_name}» не выбран получатель назначения`);
      }
      const company = lead.b24_snapshot ? JSON.parse(lead.b24_snapshot) : companyFromRow(lead);

      const { id, created } = await ensureCompany(company, {
        assignedById: lead.argus_user_id,
        kind: lead.kind,
      });

      db.prepare(`UPDATE leads SET argus_state = 'sent', argus_attempts = ?, argus_error = NULL,
                    argus_company_id = ?, updated_at = ? WHERE id = ?`)
        .run(attempts, id, nowIso(), lead.id);
      logEvent(db, lead.id, lead.assigned_team, created ? 'argus_company_created' : 'argus_company_matched',
        { argus_company_id: id, assigned_by: lead.argus_user_id, kind: lead.kind });

      // Уведомляем только теперь: до этого нет id компании, а значит и ссылки на карточку.
      const notified = enqueueAssignment(db, lead.id, lead.assigned_team);
      if (notified.queued) logEvent(db, lead.id, lead.assigned_team, 'notify_queued', notified);
      sent++;
    } catch (err) {
      failed++;
      const message = String(err.message || err);
      const exhausted = attempts >= MAX_ATTEMPTS;
      db.prepare(`UPDATE leads SET argus_attempts = ?, argus_error = ?, argus_state = ?, updated_at = ?
                  WHERE id = ?`)
        .run(attempts, message, exhausted ? 'failed' : 'pending', nowIso(), lead.id);
      logEvent(db, lead.id, lead.assigned_team, exhausted ? 'argus_failed' : 'argus_retry',
        { error: message, attempts });
    }
  }
  return { picked: rows.length, sent, failed };
}

// Строка без карточки Б24 — собираем компанию из того, что дал лидген.
function companyFromRow(lead) {
  return {
    b24_id: lead.b24_company_id || null,
    title: lead.company,
    inn: null,
    orginfo_url: null,
    oked: null,
    contacts: lead.contact_name || lead.phone || lead.email
      ? [{
          full_name: lead.contact_name || null,
          phone: lead.phone || null,
          phones: lead.phone ? [lead.phone] : [],
          email: lead.email || null,
          emails: lead.email ? [lead.email] : [],
        }]
      : [],
  };
}
