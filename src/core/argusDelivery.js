import { enqueueAssignment, enqueueDuplicateAlert } from './notify.js';
import { markDuplicate } from './queue.js';
// Компания уехала в Аргус уже назначенной: заводим её на ответственного той команды,
// которой очередь отдала строку, и сразу указываем тип — лид или встреча.
// Компания с таким ИНН уже есть — берём её, дубль не плодим.
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const MAX_ATTEMPTS = 5;
// Строка, занятая доставкой, но брошенная (упал процесс) — через столько минут её снова берут.
const STALE_SENDING_MIN = 10;

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
    -- Отказ и карантин в СРМ не заводим: компания закрыта, ход был потрачен впустую.
    -- 'sending' — строка уже у кого-то в работе; берём её только если проход умер и не вернул.
    -- Брошенную 'sending' берём даже с исчерпанными попытками: иначе она зависнет
    -- навсегда — ни в доставке, ни в 'failed', где её видно глазами.
    WHERE ((l.argus_state = 'pending' AND l.argus_attempts < ?)
           OR (l.argus_state = 'sending' AND l.updated_at <= datetime('now', ?)))
      AND l.status IN ('assigned', 'in_work')
    ORDER BY l.id LIMIT ?`).all(MAX_ATTEMPTS, `-${STALE_SENDING_MIN} minutes`, limit);
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
export async function deliverPending(db, { limit = 20, ensure, assign } = {}) {
  const rows = pending(db, limit);
  if (!rows.length) return { picked: 0, sent: 0, failed: 0, matched: 0 };

  const argus = await import('../adapters/argus.js');
  const ensureCompany = ensure || argus.ensureCompany;
  const assignCompany = assign || argus.assignCompany;

  let sent = 0, failed = 0, matched = 0, picked = 0;
  for (const lead of rows) {
    const attempts = lead.argus_attempts + 1;
    // Занимаем строку до похода в СРМ: два прохода (таймер и кнопка) иначе возьмут
    // одну и ту же, второй увидит только что заведённую компанию и решит, что она чужая.
    const taken = db.prepare(
      `UPDATE leads SET argus_state = 'sending', argus_attempts = ?, updated_at = ?
        WHERE id = ? AND (argus_state = 'pending'
          OR (argus_state = 'sending' AND updated_at <= datetime('now', ?)))`
    ).run(attempts, nowIso(), lead.id, `-${STALE_SENDING_MIN} minutes`);
    if (!Number(taken.changes || 0)) continue;   // строку успел взять другой проход
    picked++;
    try {
      if (!lead.argus_user_id) {
        throw new Error(`у команды «${lead.team_name}» не выбран получатель назначения`);
      }
      const company = lead.b24_snapshot ? JSON.parse(lead.b24_snapshot) : companyFromRow(lead);

      const notifyIds = db.prepare(`
        SELECT argus_user_id FROM team_members
        WHERE team_id = ? AND active = 1 AND role != 'assignee'`).all(lead.assigned_team)
        .map((m) => m.argus_user_id);

      // Отметка ставится ровно в момент заведения компании — не раньше.
      // По ней в следующий заход отличаем свою компанию от чужой, если ответа
      // мы не дождались, а в Аргусе она уже появилась.
      const triedBefore = !!db.prepare(
        "SELECT 1 FROM events WHERE lead_id = ? AND kind = 'argus_create_attempt'"
      ).get(lead.id);

      const res = await ensureCompany(company, {
        assignedById: lead.argus_user_id,
        kind: lead.kind,
        notifyIds,
      }, {
        onCreateAttempt: () => logEvent(db, lead.id, lead.assigned_team, 'argus_create_attempt',
          { inn: company.inn || null }),
      });
      const { id, created } = res;

      // Компания уже есть в Аргусе. Своя это или чужая — три признака:
      // тот же id компании у строки, ответственный — получатель нашей команды,
      // либо мы уже ходили в Аргус по этой строке (значит компанию завели мы,
      // а записать id помешал обрыв). Своя — это просто повторная доставка.
      const ours = res.matched
        && (String(lead.argus_company_id || '') === String(id)
          || (res.responsible && sameUser(res.responsible, lead.argus_user_id))
          || triedBefore);

      if (res.matched && ours) {
        await assignCompany(id, { assignedById: lead.argus_user_id, kind: lead.kind, notifyIds });
      }

      // Чужая компания. Ответственного не переписываем — забрать её значит отнять
      // у того, кто с ней работает. Строка идёт как фрод: ход команде возвращается
      // долгом, а руководителю команды ответственного уходит сигнал разобраться,
      // почему она попала в лидогенерацию.
      if (res.matched && !ours) {
        db.prepare(`UPDATE leads SET argus_state = 'matched', argus_attempts = ?, argus_error = NULL,
                      argus_company_id = ?, updated_at = ? WHERE id = ?`)
          .run(attempts, id, nowIso(), lead.id);
        logEvent(db, lead.id, lead.assigned_team, 'argus_company_matched', {
          argus_company_id: id, responsible: res.responsible || null, skipped_assign: true,
        });

        // Сигнал ставим в очередь до закрытия строки, но его срыв не должен оставить
        // строку полузакрытой: долг и закрытие идут в любом случае, ошибка — в журнал.
        try {
          const alert = enqueueDuplicateAlert(db, lead.id, lead.assigned_team, {
            responsible: res.responsible, argusTitle: res.title,
          });
          logEvent(db, lead.id, lead.assigned_team, 'duplicate_alert', alert);
        } catch (err) {
          logEvent(db, lead.id, lead.assigned_team, 'duplicate_error', { error: String(err.message || err) });
        }
        markDuplicate(db, lead.id);
        matched++;
        continue;
      }

      db.prepare(`UPDATE leads SET argus_state = 'sent', argus_attempts = ?, argus_error = NULL,
                    argus_company_id = ?, updated_at = ? WHERE id = ?`)
        .run(attempts, id, nowIso(), lead.id);
      logEvent(db, lead.id, lead.assigned_team, created ? 'argus_company_created' : 'argus_company_confirmed',
        { argus_company_id: id, assigned_by: lead.argus_user_id, kind: lead.kind,
          // Контакты — довесок: их срыв компанию не отменяет, но виден в журнале.
          contacts: res.contacts || null });

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
  return { picked, sent, failed, matched };
}

// Логины в Аргусе сравниваем без регистра и краевых пробелов.
const sameUser = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
  && String(a ?? '').trim() !== '';

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
