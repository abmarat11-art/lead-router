// Очередь назначений на команды.
//
// По умолчанию круг: 1,2,3,4,1,2,3,4… Отдельный курсор на лиды и на встречи —
// очереди независимы.
//
// Отказ из СРМ = фрод от лидгена. Компания закрывается и никому больше не идёт
// (в СРМ её снимают с команды в отстойник), но команда получила пустышку вместо
// своего хода — за ней остаётся долг: следующую компанию она получит вне очереди.
// Пример: назначили на 3, прилетел отказ от 1 → 1,2,3,[1],4,1,2,3,4
import { enqueueWebhook } from './webhooks.js';
import { getConfig } from './columns.js';

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

// За командой остался долг: её ход ушёл на фрод, компенсируем вне очереди.
export function pushPriority(db, kind, teamId, { leadId = null, reason = 'фрод: отказ из СРМ' } = {}) {
  db.prepare('INSERT INTO queue_priority (kind, team_id, lead_id, reason) VALUES (?, ?, ?, ?)')
    .run(kind, teamId, leadId, reason);
  logEvent(db, { leadId, teamId, kind: 'queue_debt', data: { queue: kind, reason } });
}

function openPriorities(db, kind) {
  return db.prepare(
    'SELECT p.*, t.queue_order FROM queue_priority p JOIN teams t ON t.id = p.team_id ' +
    'WHERE p.kind = ? AND p.consumed_at IS NULL ORDER BY p.id'
  ).all(kind);
}

/**
 * Кому уходит следующая компания этого вида: сначала долги, потом круг.
 * @returns {{team: object, viaPriority: number|null}|null}
 */
export function peekNext(db, kind) {
  const teams = activeTeams(db);
  if (!teams.length) return null;

  const priority = openPriorities(db, kind).find((p) => teams.some((t) => t.id === p.team_id));
  if (priority) {
    return { team: teams.find((t) => t.id === priority.team_id), viaPriority: priority.id };
  }

  const cur = cursor(db, kind);
  const next = teams.find((t) => t.queue_order > cur) || teams[0];
  return { team: next, viaPriority: null };
}

// Зафиксировать выдачу: погасить долг либо сдвинуть круговой курсор.
function commitPick(db, kind, pick, closedByLeadId) {
  if (pick.viaPriority) {
    const debt = db.prepare('SELECT * FROM queue_priority WHERE id = ?').get(pick.viaPriority);
    db.prepare('UPDATE queue_priority SET consumed_at = ?, closed_lead_id = ? WHERE id = ?')
      .run(nowIso(), closedByLeadId, pick.viaPriority);
    logEvent(db, {
      leadId: debt.lead_id, teamId: debt.team_id, kind: 'queue_debt_closed',
      data: { closed_by: closedByLeadId },
    });
    markDebtClosedInSheet(db, debt);
    return; // выдача в счёт долга круг не двигает — очередь продолжится с прежнего места
  }
  setCursor(db, kind, pick.team.queue_order);
}

// Галочка «долг закрыт» напротив той самой фродовой строки в таблице.
function markDebtClosedInSheet(db, debt) {
  if (!debt.lead_id || !process.env.SHEETS_SPREADSHEET_ID) return;
  const cfg = getConfig();
  if (!cfg.debtColumn) return;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(debt.lead_id);
  if (lead) queueSheetWrite(db, lead, cfg.debtColumn, cfg.debtClosedValue);
}

// Назначить лид следующей команде. Возвращает assignment или null (некому отдать).
export function assignNext(db, leadId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new Error(`lead ${leadId} not found`);
  if (!['new', 'escalated'].includes(lead.status)) return null;
  if (lead.enrich_state !== 'ready') return null;   // ждём карточку компании из Б24

  const pick = peekNext(db, lead.kind);
  if (!pick) {
    escalate(db, leadId, 'нет активных команд');
    return null;
  }

  commitPick(db, lead.kind, pick, leadId);

  const info = db.prepare('INSERT INTO assignments (lead_id, team_id) VALUES (?, ?)').run(leadId, pick.team.id);
  db.prepare(`UPDATE leads SET status = 'assigned', assigned_team = ?, assigned_at = ?,
                status_changed_at = ?, updated_at = ? WHERE id = ?`)
    .run(pick.team.id, nowIso(), nowIso(), nowIso(), leadId);
  logEvent(db, { leadId, teamId: pick.team.id, kind: 'assigned', data: { via_priority: !!pick.viaPriority } });

  // в таблицу — пометка «назначено»; в Аргус компания уедет уже назначенной
  queueSheetWrite(db, lead);
  db.prepare("UPDATE leads SET argus_state = 'pending', argus_attempts = 0 WHERE id = ?").run(leadId);
  enqueueWebhook(db, 'lead.assigned', leadId, pick.team.id);

  return db.prepare('SELECT * FROM assignments WHERE id = ?').get(Number(info.lastInsertRowid));
}

// Запись в таблицу напротив строки компании: статус или галочка «долг закрыт».
export function queueSheetWrite(db, lead, column, value) {
  if (!process.env.SHEETS_SPREADSHEET_ID) return null;   // таблица не подключена
  const cfg = getConfig();
  const info = db.prepare('INSERT INTO sheet_writes (lead_id, source_key, column_ref, value) VALUES (?, ?, ?, ?)')
    .run(lead.id, lead.source_key, column || cfg.statusColumn, value ?? cfg.statuses.assigned);
  return Number(info.lastInsertRowid);
}

// СРМ отметила «в работе».
export function markInWork(db, leadId) {
  const a = openAssignment(db, leadId);
  if (a) {
    db.prepare("UPDATE assignments SET state = 'in_work', resolved_at = ? WHERE id = ?").run(nowIso(), a.id);
  }
  db.prepare("UPDATE leads SET status = 'in_work', status_changed_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), leadId);
  logEvent(db, { leadId, teamId: a?.team_id ?? null, kind: 'in_work' });
  enqueueWebhook(db, 'lead.in_work', leadId, a?.team_id ?? null);
  return { ok: true };
}

// СРМ отметила «отказ» — это фрод от лидгена. Компанию закрываем: в СРМ её сняли
// с команды в отстойник, дальше по кругу она не идёт. Команде записываем долг:
// её ход ушёл впустую, следующую компанию она получит вне очереди.
export function markDeclined(db, leadId, reason = null) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  const a = openAssignment(db, leadId);
  if (a) {
    db.prepare("UPDATE assignments SET state = 'declined', resolved_at = ?, reason = ? WHERE id = ?")
      .run(nowIso(), reason, a.id);
    pushPriority(db, lead.kind, a.team_id, { leadId, reason: reason || 'фрод: отказ из СРМ' });
  }

  db.prepare(`UPDATE leads SET status = 'rejected', decline_count = decline_count + 1,
                status_changed_at = ?, updated_at = ? WHERE id = ?`)
    .run(nowIso(), nowIso(), leadId);
  logEvent(db, { leadId, teamId: a?.team_id ?? null, kind: 'declined', data: { reason } });
  enqueueWebhook(db, 'lead.declined', leadId, a?.team_id ?? null, { reason });

  return { ok: true, debt_team: a?.team_id ?? null };
}

function openAssignment(db, leadId) {
  return db.prepare("SELECT * FROM assignments WHERE lead_id = ? AND state = 'pending' ORDER BY id DESC").get(leadId);
}

export function escalate(db, leadId, reason) {
  db.prepare(`UPDATE leads SET status = 'escalated', assigned_team = NULL,
                status_changed_at = ?, updated_at = ? WHERE id = ?`)
    .run(nowIso(), nowIso(), leadId);
  logEvent(db, { leadId, kind: 'escalated', data: { reason } });
  enqueueWebhook(db, 'lead.escalated', leadId, null, { reason });
}

// Ручное назначение из интерфейса — минуя очередь.
export function assignManually(db, leadId, teamId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  db.prepare("UPDATE assignments SET state = 'cancelled', resolved_at = ? WHERE lead_id = ? AND state = 'pending'")
    .run(nowIso(), leadId);
  db.prepare('INSERT INTO assignments (lead_id, team_id) VALUES (?, ?)').run(leadId, teamId);
  db.prepare(`UPDATE leads SET status = 'assigned', assigned_team = ?, assigned_at = ?,
                status_changed_at = ?, updated_at = ? WHERE id = ?`)
    .run(teamId, nowIso(), nowIso(), nowIso(), leadId);
  logEvent(db, { leadId, teamId, kind: 'assigned_manually' });
  queueSheetWrite(db, lead);
  db.prepare("UPDATE leads SET argus_state = 'pending', argus_attempts = 0 WHERE id = ?").run(leadId);
  enqueueWebhook(db, 'lead.assigned', leadId, teamId, { manual: true });
  return { ok: true };
}

// Разобрать пул: всё, что пришло из таблицы с пустым статусом.
export function dispatchQueue(db, { limit = 100 } = {}) {
  // компании, которые ещё заводятся в Аргусе, не раздаём
  const leads = db.prepare(
    "SELECT id FROM leads WHERE status = 'new' AND enrich_state = 'ready' ORDER BY imported_at, id LIMIT ?"
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
