// Движок распределения: кому предложить лид, что делать с ответом.
import { enqueueWebhook } from './webhooks.js';

export const MAX_DECLINES = 3;

const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const plusMinutes = (min, from = new Date()) =>
  new Date(from.getTime() + min * 60_000).toISOString().slice(0, 19).replace('T', ' ');

function logEvent(db, { leadId = null, employeeId = null, kind, data = {} }) {
  db.prepare('INSERT INTO events (lead_id, employee_id, kind, data) VALUES (?, ?, ?, ?)')
    .run(leadId, employeeId, kind, JSON.stringify(data));
}

// Сотрудники, которым этот лид вообще можно предложить.
export function eligibleEmployees(db, lead, { excludeIds = [] } = {}) {
  const rows = db.prepare(
    'SELECT * FROM employees WHERE active = 1 AND (? IS NULL OR team_id = ?) ORDER BY queue_order, id'
  ).all(lead.team_id ?? null, lead.team_id ?? null);

  return rows.filter((e) => {
    if (excludeIds.includes(e.id)) return false;
    const langs = JSON.parse(e.langs || '[]');
    if (lead.lang && langs.length && !langs.includes(lead.lang)) return false;
    if (e.daily_limit > 0 && assignedToday(db, e.id) >= e.daily_limit) return false;
    return true;
  });
}

export function assignedToday(db, employeeId) {
  return db.prepare(
    "SELECT COUNT(*) c FROM offers WHERE employee_id = ? AND state = 'accepted' AND date(responded_at) = date('now')"
  ).get(employeeId).c;
}

function inWork(db, employeeId) {
  return db.prepare(
    "SELECT COUNT(*) c FROM leads WHERE assigned_to = ? AND status = 'assigned'"
  ).get(employeeId).c;
}

// Кому отдать следующим: очередь по кругу либо выравнивание нагрузки.
export function pickNext(db, lead, candidates) {
  if (!candidates.length) return null;
  const team = lead.team_id
    ? db.prepare('SELECT * FROM teams WHERE id = ?').get(lead.team_id)
    : null;

  if (team?.strategy === 'balance') {
    return candidates
      .map((e) => ({ e, load: inWork(db, e.id) }))
      .sort((a, b) => a.load - b.load || a.e.queue_order - b.e.queue_order)[0].e;
  }

  const cursor = team?.rr_cursor ?? 0;
  const next = candidates.find((e) => e.queue_order > cursor) || candidates[0];
  if (team) db.prepare('UPDATE teams SET rr_cursor = ? WHERE id = ?').run(next.queue_order, team.id);
  return next;
}

// Предложить лид следующему подходящему сотруднику. Возвращает offer или null.
export function offerLead(db, leadId, { ttlMinutes = Number(process.env.OFFER_TTL_MINUTES) || 15 } = {}) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new Error(`lead ${leadId} not found`);
  if (['assigned', 'quarantine', 'escalated'].includes(lead.status)) return null;

  // тем, кто уже отказался по этому лиду, повторно не предлагаем
  const refused = db.prepare(
    "SELECT employee_id FROM offers WHERE lead_id = ? AND state IN ('declined','expired')"
  ).all(leadId).map((r) => r.employee_id);

  const candidate = pickNext(db, lead, eligibleEmployees(db, lead, { excludeIds: refused }));
  if (!candidate) {
    escalate(db, leadId, 'нет подходящих свободных сотрудников');
    return null;
  }

  const info = db.prepare(
    'INSERT INTO offers (lead_id, employee_id, offered_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(leadId, candidate.id, nowIso(), plusMinutes(ttlMinutes));

  db.prepare("UPDATE leads SET status = 'offered', updated_at = ? WHERE id = ?").run(nowIso(), leadId);
  logEvent(db, { leadId, employeeId: candidate.id, kind: 'offered', data: { ttlMinutes } });

  return db.prepare('SELECT * FROM offers WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function acceptOffer(db, offerId) {
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
  if (!offer) throw new Error(`offer ${offerId} not found`);
  if (offer.state !== 'pending') return { ok: false, reason: offer.state };

  db.prepare("UPDATE offers SET state = 'accepted', responded_at = ? WHERE id = ?").run(nowIso(), offerId);
  db.prepare("UPDATE leads SET status = 'assigned', assigned_to = ?, updated_at = ? WHERE id = ?")
    .run(offer.employee_id, nowIso(), offer.lead_id);
  logEvent(db, { leadId: offer.lead_id, employeeId: offer.employee_id, kind: 'accepted' });
  enqueueWebhook(db, 'lead.assigned', offer.lead_id, offer.employee_id);
  return { ok: true };
}

export function declineOffer(db, offerId, reason = null) {
  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(offerId);
  if (!offer) throw new Error(`offer ${offerId} not found`);
  if (offer.state !== 'pending') return { ok: false, reason: offer.state };

  db.prepare("UPDATE offers SET state = 'declined', reason = ?, responded_at = ? WHERE id = ?")
    .run(reason, nowIso(), offerId);
  return afterRefusal(db, offer, 'declined', { reason });
}

// Протухшие предложения: не ответил в срок — уходит следующему.
export function expireOffers(db) {
  const stale = db.prepare(
    "SELECT * FROM offers WHERE state = 'pending' AND expires_at <= ?"
  ).all(nowIso());

  for (const offer of stale) {
    db.prepare("UPDATE offers SET state = 'expired', responded_at = ? WHERE id = ?").run(nowIso(), offer.id);
    afterRefusal(db, offer, 'expired', {});
  }
  return stale.length;
}

function afterRefusal(db, offer, kind, data) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(offer.lead_id);
  const declines = lead.decline_count + 1;
  db.prepare("UPDATE leads SET decline_count = ?, status = 'queued', assigned_to = NULL, updated_at = ? WHERE id = ?")
    .run(declines, nowIso(), lead.id);
  logEvent(db, { leadId: lead.id, employeeId: offer.employee_id, kind, data });
  enqueueWebhook(db, kind === 'expired' ? 'lead.expired' : 'lead.declined', lead.id, offer.employee_id, data);

  if (declines >= MAX_DECLINES) {
    escalate(db, lead.id, `${declines} отказа подряд`);
    return { ok: true, escalated: true };
  }
  const next = offerLead(db, lead.id);
  return { ok: true, escalated: false, nextOfferId: next?.id ?? null };
}

// Лид некому отдать или его футболят — на стол руководителю.
export function escalate(db, leadId, reason) {
  db.prepare("UPDATE leads SET status = 'escalated', assigned_to = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), leadId);
  logEvent(db, { leadId, kind: 'escalated', data: { reason } });
  enqueueWebhook(db, 'lead.escalated', leadId, null, { reason });
}

// Ручное назначение из интерфейса — минуя очередь.
export function assignManually(db, leadId, employeeId) {
  db.prepare("UPDATE offers SET state = 'cancelled', responded_at = ? WHERE lead_id = ? AND state = 'pending'")
    .run(nowIso(), leadId);
  db.prepare("UPDATE leads SET status = 'assigned', assigned_to = ?, updated_at = ? WHERE id = ?")
    .run(employeeId, nowIso(), leadId);
  logEvent(db, { leadId, employeeId, kind: 'assigned_manually' });
  enqueueWebhook(db, 'lead.assigned', leadId, employeeId, { manual: true });
}

// Разослать всё, что лежит в очереди нераспределённым.
export function dispatchQueue(db, { limit = 50 } = {}) {
  const leads = db.prepare(
    "SELECT id FROM leads WHERE status IN ('new','queued') ORDER BY imported_at LIMIT ?"
  ).all(limit);
  let offered = 0;
  for (const { id } of leads) if (offerLead(db, id)) offered++;
  return { seen: leads.length, offered };
}
