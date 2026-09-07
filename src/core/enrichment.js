// Компании нет в Аргусе — заводим её до назначения.
// По id из таблицы забираем карточку из Б24, создаём компанию с контактами в Аргусе,
// запоминаем её id. Пока это не сделано, лид в очередь не идёт: команда должна
// получить компанию, которая в СРМ уже существует.
import { createHmac, randomUUID } from 'node:crypto';

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

// Создание компании в Аргусе — отдельный вебхук, синхронный: нам нужен id в ответе.
async function createInArgus(company, { fetchImpl = fetch } = {}) {
  const url = process.env.ARGUS_COMPANY_URL;
  if (!url) throw new Error('ARGUS_COMPANY_URL не задан');

  const body = JSON.stringify({
    id: randomUUID(),
    event: 'company.create',
    occurred_at: new Date().toISOString(),
    company: {
      b24_id: company.b24_id,
      title: company.title,
      inn: company.inn,
      orginfo_url: company.orginfo_url,
      oked: company.oked,
    },
    contacts: company.contacts,
  });

  const secret = process.env.ARGUS_WEBHOOK_SECRET;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lead-router-event': 'company.create',
      ...(secret ? { 'x-lead-router-signature': createHmac('sha256', secret).update(body).digest('hex') } : {}),
    },
    body,
  });
  if (!res.ok) throw new Error(`Аргус company.create: HTTP ${res.status}`);

  const data = await res.json().catch(() => ({}));
  const id = data.company_id ?? data.id ?? data.result?.id ?? null;
  if (!id) throw new Error('Аргус не вернул id созданной компании');
  return String(id);
}

/**
 * Один проход: дотянуть карточки и завести компании.
 * @param {{fetchCompany?: Function, createCompany?: Function}} deps подменяются в тестах
 */
export async function enrichPending(db, { limit = 20, fetchCompany, createCompany } = {}) {
  const rows = pending(db, limit);
  if (!rows.length) return { picked: 0, ready: 0, failed: 0 };

  const getCompany = fetchCompany || (await import('../adapters/bitrix.js')).fetchCompany;
  const create = createCompany || createInArgus;

  let ready = 0, failed = 0;
  for (const lead of rows) {
    const attempts = lead.enrich_attempts + 1;
    try {
      if (!lead.b24_company_id) throw new Error('в строке нет id компании Б24');
      const company = await getCompany(lead.b24_company_id);
      const argusId = await create(company);

      db.prepare(`UPDATE leads SET enrich_state = 'ready', enrich_attempts = ?, enrich_error = NULL,
                    argus_company_id = ?, company = COALESCE(NULLIF(company, ''), ?), updated_at = ?
                  WHERE id = ?`)
        .run(attempts, argusId, company.title, nowIso(), lead.id);
      logEvent(db, lead.id, 'company_created', { b24_id: company.b24_id, argus_company_id: argusId, contacts: company.contacts.length });
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
