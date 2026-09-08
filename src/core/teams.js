import { retryTeam } from './argusDelivery.js';
// Команда — это люди в Аргусе. Один из них получает назначение (роль assignee),
// остальные видят уведомления. Любую правку пишем в журнал команды: через месяц
// нужно понимать, почему компания ушла именно на этого человека.
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export function logTeamChange(db, teamId, kind, data = {}) {
  db.prepare('INSERT INTO team_history (team_id, kind, data) VALUES (?, ?, ?)')
    .run(teamId, kind, JSON.stringify(data));
}

export const listMembers = (db, teamId) =>
  db.prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY role, id').all(teamId);

export const teamHistory = (db, teamId, limit = 100) =>
  db.prepare('SELECT * FROM team_history WHERE team_id = ? ORDER BY id DESC LIMIT ?').all(teamId, limit);

/** Кому заводить компанию: активный участник с ролью assignee. */
export function assigneeOf(db, teamId) {
  const row = db.prepare(
    "SELECT * FROM team_members WHERE team_id = ? AND role = 'assignee' AND active = 1 ORDER BY id LIMIT 1"
  ).get(teamId);
  return row?.argus_user_id ?? null;
}

/** Кого уведомлять: все активные, кроме получателя. */
export const notifyListOf = (db, teamId) =>
  db.prepare("SELECT * FROM team_members WHERE team_id = ? AND role = 'notify' AND active = 1 ORDER BY id")
    .all(teamId).map((m) => m.argus_user_id);

/** Появился получатель — поднимаем то, что упало без него. */
function reviveTeamDelivery(db, teamId) {
  if (!assigneeOf(db, teamId)) return;
  const { revived } = retryTeam(db, teamId);
  if (revived) logTeamChange(db, teamId, 'delivery_retried', { revived });
}

export function addMember(db, teamId, { argus_user_id, name = null, role = 'notify' }) {
  if (!argus_user_id) throw new Error('нужен id пользователя в Аргусе');
  if (role === 'assignee') demoteAssignees(db, teamId);

  const info = db.prepare(
    'INSERT INTO team_members (team_id, argus_user_id, name, role) VALUES (?, ?, ?, ?)'
  ).run(teamId, String(argus_user_id).trim(), name, role);

  logTeamChange(db, teamId, 'member_added', { argus_user_id, name, role });
  reviveTeamDelivery(db, teamId);
  return Number(info.lastInsertRowid);
}

export function updateMember(db, teamId, memberId, patch) {
  const before = db.prepare('SELECT * FROM team_members WHERE id = ? AND team_id = ?').get(memberId, teamId);
  if (!before) throw new Error('участник не найден');

  // получатель в команде один: назначая нового, снимаем роль со старого
  if (patch.role === 'assignee' && before.role !== 'assignee') demoteAssignees(db, teamId);

  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!['argus_user_id', 'name', 'role', 'active'].includes(k)) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (!fields.length) return before;

  db.prepare(`UPDATE team_members SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, nowIso(), memberId);

  const after = db.prepare('SELECT * FROM team_members WHERE id = ?').get(memberId);
  logTeamChange(db, teamId, 'member_changed', {
    argus_user_id: after.argus_user_id,
    was: { role: before.role, active: before.active, argus_user_id: before.argus_user_id },
    now: { role: after.role, active: after.active, argus_user_id: after.argus_user_id },
  });
  reviveTeamDelivery(db, teamId);
  return after;
}

export function removeMember(db, teamId, memberId) {
  const member = db.prepare('SELECT * FROM team_members WHERE id = ? AND team_id = ?').get(memberId, teamId);
  if (!member) return { ok: false };
  db.prepare('DELETE FROM team_members WHERE id = ?').run(memberId);
  logTeamChange(db, teamId, 'member_removed', { argus_user_id: member.argus_user_id, role: member.role });
  return { ok: true };
}

function demoteAssignees(db, teamId) {
  const current = db.prepare("SELECT * FROM team_members WHERE team_id = ? AND role = 'assignee'").all(teamId);
  if (!current.length) return;
  db.prepare("UPDATE team_members SET role = 'notify', updated_at = ? WHERE team_id = ? AND role = 'assignee'")
    .run(nowIso(), teamId);
  for (const m of current) {
    logTeamChange(db, teamId, 'assignee_replaced', { was: m.argus_user_id });
  }
}
