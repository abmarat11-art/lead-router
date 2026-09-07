// Подготовка строки к раздаче: тянем карточку компании из Б24 и складываем её у себя.
// Саму компанию в Аргусе заводим позже — только когда очередь выбрала команду,
// потому что компания создаётся сразу на ответственного этой команды.
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const MAX_ATTEMPTS = 5;

function logEvent(db, leadId, kind, data = {}) {
  db.prepare('INSERT INTO events (lead_id, kind, data) VALUES (?, ?, ?)')
    .run(leadId, kind, JSON.stringify(data));
}

/** Строки, которым нужна карточка из Б24. */
export function pending(db, limit = 20) {
  return db.prepare(
    "SELECT * FROM leads WHERE enrich_state = 'pending' AND status = 'new' AND enrich_attempts < ? ORDER BY id LIMIT ?"
  ).all(MAX_ATTEMPTS, limit);
}

/**
 * Один проход: дотянуть карточки компаний из Б24.
 * @param {{fetchCompany?: Function}} deps подменяется в тестах
 */
export async function enrichPending(db, { limit = 20, fetchCompany } = {}) {
  const rows = pending(db, limit);
  if (!rows.length) return { picked: 0, ready: 0, failed: 0 };

  const getCompany = fetchCompany || (await import('../adapters/bitrix.js')).fetchCompany;

  let ready = 0, failed = 0;
  for (const lead of rows) {
    const attempts = lead.enrich_attempts + 1;
    try {
      if (!lead.b24_company_id) throw new Error('в строке нет id компании Б24');
      const company = await getCompany(lead.b24_company_id);
      if (!company.inn) throw new Error('в карточке Б24 нет ИНН — Аргус без него компанию не заведёт');

      db.prepare(`UPDATE leads SET enrich_state = 'ready', enrich_attempts = ?, enrich_error = NULL,
                    b24_snapshot = ?, company = COALESCE(NULLIF(company, ''), ?), updated_at = ?
                  WHERE id = ?`)
        .run(attempts, JSON.stringify(company), company.title, nowIso(), lead.id);
      logEvent(db, lead.id, 'b24_fetched', { b24_id: company.b24_id, contacts: company.contacts.length });
      ready++;
    } catch (err) {
      failed++;
      const message = String(err.message || err);
      const exhausted = attempts >= MAX_ATTEMPTS;
      db.prepare(`UPDATE leads SET enrich_attempts = ?, enrich_error = ?, enrich_state = ?,
                    status = CASE WHEN ? THEN 'escalated' ELSE status END, updated_at = ?
                  WHERE id = ?`)
        .run(attempts, message, exhausted ? 'failed' : 'pending', exhausted ? 1 : 0, nowIso(), lead.id);
      logEvent(db, lead.id, exhausted ? 'enrich_failed' : 'enrich_retry', { error: message, attempts });
    }
  }
  return { picked: rows.length, ready, failed };
}
