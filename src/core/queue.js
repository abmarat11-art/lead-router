// Очередь назначений на команды.
//
// По умолчанию круг: 1,2,3,4,1,2,3,4… Отдельный курсор на лиды и на встречи —
// очереди независимы. Отказ из СРМ ставит команду вне очереди: она получит
// следующую компанию раньше остальных, а обычный круг продолжится с того же места.
// Пример: назначили на 3, прилетел отказ от 1 → 1,2,3,[1],4,1,2,3,4
import { enqueueWebhook } from './webhooks.js';

export const KINDS = ['lead', 'meeting'];

const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export function logEvent(db, { leadId = null, teamId = null, kind, data = {} }) {
  db.prepare('INSERT INTO events (lead_id, team_id, kind, data) VALUES (?, ?, ?, ?)')
    .run(leadId, teamId, kind, JSON.stringify(data));
}

export function activeTeams(db) {
  return db.prepare('SELECT * FROM teams WHERE active = 1 ORDER BY queue_order, id').all();
}

function cursor(db, kind) {
  db.prepare('INSERT OR IGNORE INTO queue_state (kind, cursor) VALUES (?, 0)').run(kind);
  return db.prepare('SELECT cursor FROM queue_state WHERE kind = ?').get(kind).cursor;
}

function setCursor(db, kind, value) {
  db.prepare('INSERT INTO queue_state (kind, cursor) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET cursor = excluded.cursor')
    .run(kind, value);
}

// Команда получила отказ — ставим её следующей в очереди своего вида.
export function pushPriority(db, kind, teamId, reason = 'отказ из СРМ') {
  db.prepare('INSERT INTO queue_priority (kind, team_id, reason) VALUES (?, ?, ?)').run(kind, teamId, reason);
  logEvent(db, { teamId, kind: 'queue_priority', data: { queue: kind, reason } });
}

function openPriorities(db, kind) {
  return db.prepare(
    'SELECT p.*, t.queue_order FROM queue_priority p JOIN teams t ON t.id = p.team_id ' +
    'WHERE p.kind = ? AND p.consumed_at IS NULL ORDER BY p.id'
  ).all(kind);
}

/**
 * Кому уходит следующая компания этого вида.
 * @param {number[]} exclude команды, которым этот лид уже отдавали
 * @returns {{team: object, viaPriority: number|null}|null}
 */
export function peekNext(db, kind, { exclude = [] } = {}) {
  const teams = activeTeams(db).filter((t) => !exclude.includes(t.id));
  if (!teams.length) return null;

  const priority = openPriorities(db, kind).find((p) => teams.some((t) => t.id === p.team_id));
  if (priority) {
    return { team: teams.find((t) => t.id === priority.team_id), viaPriority: priority.id };
  }

  const cur = cursor(db, kind);
  const next = teams.find((t) => t.queue_order > cur) || teams[0];
  return { team: next, viaPriority: null };
}

// Зафиксировать выдачу: списать внеочередника либо сдвинуть круговой курсор.
// reassign = возврат отказанной компании: круг он не двигает, иначе команда,
// стоявшая следующей, потеряла бы свой ход из-за чужого отказа.
function commitPick(db, kind, pick, { reassign = false } = {}) {
  if (pick.viaPriority) {
    db.prepare('UPDATE queue_priority SET consumed_at = ? WHERE id = ?').run(nowIso(), pick.viaPriority);
    return; // круговой курсор внеочередник не сдвигает — очередь продолжится с прежнего места
  }
  if (!reassign) setCursor(db, kind, pick.team.queue_order);
}

// Назначить лид следующей команде. Возвращает assignment или null (некому отдать).
export function assignNext(db, leadId, { reassign = false } = {}) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new Error(`lead ${leadId} not found`);
  if (!['new', 'escalated'].includes(lead.status)) return null;

  // командам, которые уже отказались по этой компании, повторно не отдаём
  const refused = db.prepare("SELECT team_id FROM assignments WHERE lead_id = ? AND state = 'declined'")
    .all(leadId).map((r) => r.team_id);

  const pick = peekNext(db, lead.kind, { exclude: refused });
  if (!pick) {
    escalate(db, leadId, refused.length ? 'все команды отказались' : 'нет активных команд');
    return null;
  }

  commitPick(db, lead.kind, pick, { reassign });

  const info = db.prepare('INSERT INTO assignments (lead_id, team_id) VALUES (?, ?)').run(leadId, pick.team.id);
  db.prepare("UPDATE leads SET status = 'assigned', assigned_team = ?, updated_at = ? WHERE id = ?")
    .run(pick.team.id, nowIso(), leadId);
  logEvent(db, { leadId, teamId: pick.team.id, kind: 'assigned', data: { via_priority: !!pick.viaPriority, reassign } });

  // в таблицу — пометка «назначено», в СРМ — вебхук
  queueSheetWrite(db, lead, process.env.SHEET_STATUS_ASSIGNED || 'назначено');
  enqueueWebhook(db, 'lead.assigned', leadId, pick.team.id);

  return db.prepare('SELECT * FROM assignments WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function queueSheetWrite(db, lead, value) {
  if (!process.env.SHEETS_STATUS_COLUMN) return null;
  const info = db.prepare('INSERT INTO sheet_writes (lead_id, source_key, value) VALUES (?, ?, ?)')
    .run(lead.id, lead.source_key, value);
  return Number(info.lastInsertRowid);
}

// СРМ отметила «в работе».
export function markInWork(db, leadId) {
  const a = openAssignment(db, leadId);
  if (a) {
    db.prepare("UPDATE assignments SET state = 'in_work', resolved_at = ? WHERE id = ?").run(nowIso(), a.id);
  }
  db.prepare("UPDATE leads SET status = 'in_work', updated_at = ? WHERE id = ?").run(nowIso(), leadId);
  logEvent(db, { leadId, teamId: a?.team_id ?? null, kind: 'in_work' });
  enqueueWebhook(db, 'lead.in_work', leadId, a?.team_id ?? null);
  return { ok: true };
}

// СРМ отметила «отказ»: команда встаёт вне очереди, компания уходит следующей.
export function markDeclined(db, leadId, reason = null) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  const a = openAssignment(db, leadId);
  if (a) {
    db.prepare("UPDATE assignments SET state = 'declined', resolved_at = ?, reason = ? WHERE id = ?")
      .run(nowIso(), reason, a.id);
    pushPriority(db, lead.kind, a.team_id, reason || 'отказ из СРМ');
  }

  db.prepare("UPDATE leads SET status = 'new', assigned_team = NULL, decline_count = decline_count + 1, updated_at = ? WHERE id = ?")
    .run(nowIso(), leadId);
  logEvent(db, { leadId, teamId: a?.team_id ?? null, kind: 'declined', data: { reason } });
  enqueueWebhook(db, 'lead.declined', leadId, a?.team_id ?? null, { reason });

  return { ok: true, next: assignNext(db, leadId, { reassign: true }) };
}

function openAssignment(db, leadId) {
  return db.prepare("SELECT * FROM assignments WHERE lead_id = ? AND state = 'pending' ORDER BY id DESC").get(leadId);
}

export function escalate(db, leadId, reason) {
  db.prepare("UPDATE leads SET status = 'escalated', assigned_team = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), leadId);
  logEvent(db, { leadId, kind: 'escalated', data: { reason } });
  enqueueWebhook(db, 'lead.escalated', leadId, null, { reason });
}

// Ручное назначение из интерфейса — минуя очередь.
export function assignManually(db, leadId, teamId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  db.prepare("UPDATE assignments SET state = 'cancelled', resolved_at = ? WHERE lead_id = ? AND state = 'pending'")
    .run(nowIso(), leadId);
  db.prepare('INSERT INTO assignments (lead_id, team_id) VALUES (?, ?)').run(leadId, teamId);
  db.prepare("UPDATE leads SET status = 'assigned', assigned_team = ?, updated_at = ? WHERE id = ?")
    .run(teamId, nowIso(), leadId);
  logEvent(db, { leadId, teamId, kind: 'assigned_manually' });
  queueSheetWrite(db, lead, process.env.SHEET_STATUS_ASSIGNED || 'назначено');
  enqueueWebhook(db, 'lead.assigned', leadId, teamId, { manual: true });
  return { ok: true };
}

// Разобрать пул: всё, что пришло из таблицы с пустым статусом.
export function dispatchQueue(db, { limit = 100 } = {}) {
  const leads = db.prepare(
    "SELECT id FROM leads WHERE status = 'new' ORDER BY imported_at, id LIMIT ?"
  ).all(limit);
  let assigned = 0;
  for (const { id } of leads) if (assignNext(db, id)) assigned++;
  return { seen: leads.length, assigned };
}

// Как выглядит очередь дальше — для интерфейса.
export function queuePreview(db, kind, steps = 8) {
  const teams = activeTeams(db);
  if (!teams.length) return [];
  const pending = openPriorities(db, kind).map((p) => p.team_id);
  const out = [];
  let cur = cursor(db, kind);
  for (let i = 0; i < steps; i++) {
    if (pending.length) {
      const id = pending.shift();
      out.push({ team_id: id, via_priority: true });
      continue;
    }
    const next = teams.find((t) => t.queue_order > cur) || teams[0];
    cur = next.queue_order;
    out.push({ team_id: next.id, via_priority: false });
  }
  return out;
}
