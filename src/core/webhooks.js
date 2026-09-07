// Исходящие вебхуки в Аргус. Пишем в outbox, отправляем отдельным воркером
// с ретраями — чтобы падение CRM не ломало распределение.
import { createHmac, randomUUID } from 'node:crypto';

const BACKOFF_SEC = [0, 30, 120, 600, 3600];
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export function enqueueWebhook(db, event, leadId, employeeId = null, extra = {}) {
  const url = process.env.ARGUS_WEBHOOK_URL;
  if (!url) return null; // вебхуки ещё не настроены — молча копим только в events

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  const employee = employeeId
    ? db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId)
    : null;

  const payload = {
    id: randomUUID(),
    event,
    occurred_at: new Date().toISOString(),
    lead: lead && {
      id: lead.id,
      source_key: lead.source_key,
      company: lead.company,
      contact_name: lead.contact_name,
      phone: lead.phone,
      email: lead.email,
      lead_gen: lead.lead_gen,
      outcome_type: lead.outcome_type,
      lang: lead.lang,
      region: lead.region,
      status: lead.status,
      raw: JSON.parse(lead.raw || '{}'),
    },
    employee: employee && {
      id: employee.id,
      name: employee.name,
      tg_user_id: employee.tg_user_id,
      team_id: employee.team_id,
    },
    ...extra,
  };

  const info = db.prepare(
    'INSERT INTO webhook_outbox (event, payload, url) VALUES (?, ?, ?)'
  ).run(event, JSON.stringify(payload), url);
  return Number(info.lastInsertRowid);
}

function sign(body) {
  const secret = process.env.ARGUS_WEBHOOK_SECRET;
  return secret ? createHmac('sha256', secret).update(body).digest('hex') : null;
}

// Один проход воркера: берём готовые к отправке, шлём, планируем повтор.
export async function flushOutbox(db, { limit = 20, fetchImpl = fetch } = {}) {
  const rows = db.prepare(
    "SELECT * FROM webhook_outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?"
  ).all(nowIso(), limit);

  let sent = 0, failed = 0;
  for (const row of rows) {
    const attempts = row.attempts + 1;
    try {
      const signature = sign(row.payload);
      const res = await fetchImpl(row.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lead-router-event': row.event,
          ...(signature ? { 'x-lead-router-signature': signature } : {}),
        },
        body: row.payload,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      db.prepare("UPDATE webhook_outbox SET state = 'sent', attempts = ?, sent_at = ? WHERE id = ?")
        .run(attempts, nowIso(), row.id);
      sent++;
    } catch (err) {
      failed++;
      const backoff = BACKOFF_SEC[Math.min(attempts, BACKOFF_SEC.length - 1)];
      const state = attempts >= BACKOFF_SEC.length ? 'failed' : 'pending';
      db.prepare(
        "UPDATE webhook_outbox SET attempts = ?, state = ?, last_error = ?, next_attempt_at = datetime('now', ?) WHERE id = ?"
      ).run(attempts, state, String(err.message || err), `+${backoff} seconds`, row.id);
    }
  }
  return { picked: rows.length, sent, failed };
}
