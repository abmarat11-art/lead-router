// Компании нет в Аргусе — заводим её до назначения.
// По id из таблицы забираем карточку из Б24, создаём компанию с контактами в Аргусе,
// запоминаем её id. Пока это не сделано, лид в очередь не идёт: команда должна
// получить компанию, которая в СРМ уже существует.
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const MAX_ATTEMPTS = 5;

function logEvent(db, leadId, kind, data = {}) {
  db.prepare('INSERT INTO events (lead_id, kind, data) VALUES (?, ?, ?)')
    .run(leadId, kind, JSON.stringify(data));
}

/** Строки, которым нужна компания в Аргусе. */
export function pending(db, limit = 20) {
  return db.prepare(
    "SELECT * FROM leads WHERE enrich_state = 'pending' AND status = 'new' AND enrich_attempts < ? ORDER BY id LIMIT ?"
  ).all(MAX_ATTEMPTS, limit);
}

/**
 * Один проход: дотянуть карточки из Б24 и завести компании в Аргусе.
 * Компания с таким ИНН уже есть — берём её, второй раз не создаём.
 * @param {{fetchCompany?: Function, createCompany?: Function}} deps подменяются в тестах
 */
export async function enrichPending(db, { limit = 20, fetchCompany, createCompany } = {}) {
  const rows = pending(db, limit);
  if (!rows.length) return { picked: 0, ready: 0, failed: 0 };

  const getCompany = fetchCompany || (await import('../adapters/bitrix.js')).fetchCompany;
  const create = createCompany || (async (company) => {
    const { ensureCompany } = await import('../adapters/argus.js');
    const { id, created } = await ensureCompany(company);
    return { id, created };
  });

  let ready = 0, failed = 0;
  for (const lead of rows) {
    const attempts = lead.enrich_attempts + 1;
    try {
      if (!lead.b24_company_id) throw new Error('в строке нет id компании Б24');
      const company = await getCompany(lead.b24_company_id);
      const result = await create(company);
      // адаптер отдаёт {id, created}, тесты могут вернуть просто строку
      const argusId = typeof result === 'string' ? result : result.id;
      const created = typeof result === 'string' ? true : result.created;

      db.prepare(`UPDATE leads SET enrich_state = 'ready', enrich_attempts = ?, enrich_error = NULL,
                    argus_company_id = ?, company = COALESCE(NULLIF(company, ''), ?), updated_at = ?
                  WHERE id = ?`)
        .run(attempts, argusId, company.title, nowIso(), lead.id);
      logEvent(db, lead.id, created ? 'company_created' : 'company_matched',
        { b24_id: company.b24_id, argus_company_id: argusId, contacts: company.contacts.length });
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
