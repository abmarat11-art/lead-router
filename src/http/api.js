// HTTP API поверх node:http — без фреймворка, роутов немного.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assignNext, dispatchQueue, assignManually, escalate, markInWork, markDeclined,
  queuePreview, activeTeams, KINDS,
} from '../core/queue.js';
import { releaseFromQuarantine, importBatch } from '../core/importer.js';
import { getConfig } from '../core/columns.js';
import {
  listMembers, teamHistory, addMember, updateMember, removeMember, logTeamChange,
} from '../core/teams.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

export function createHandler(db, { importNow } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const seg = p.split('/').filter(Boolean);

    try {
      if (p === '/health') return json(res, 200, { ok: true });

      // ---- чтение ----
      if (req.method === 'GET' && p === '/api/leads') {
        const status = url.searchParams.get('status');
        const kind = url.searchParams.get('kind');
        const where = [];
        const args = [];
        if (status) { where.push('status = ?'); args.push(status); }
        if (kind) { where.push('kind = ?'); args.push(kind); }
        const rows = db.prepare(
          `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY imported_at DESC, id DESC LIMIT 500`
        ).all(...args);
        return json(res, 200, rows.map(decorate(db)));
      }

      if (req.method === 'GET' && p === '/api/teams') {
        const teams = db.prepare('SELECT * FROM teams ORDER BY queue_order, id').all();
        return json(res, 200, teams.map((t) => ({ ...t, members: listMembers(db, t.id) })));
      }

      // ---- состав команды и её журнал ----
      if (seg[1] === 'teams' && seg[3] === 'members') {
        const teamId = Number(seg[2]);
        if (req.method === 'GET') return json(res, 200, listMembers(db, teamId));
        if (req.method === 'POST') {
          const b = await readJson(req);
          return json(res, 200, { id: addMember(db, teamId, b) });
        }
        if (req.method === 'PATCH' && seg[4]) {
          const b = await readJson(req);
          return json(res, 200, updateMember(db, teamId, Number(seg[4]), b));
        }
        if (req.method === 'DELETE' && seg[4]) {
          return json(res, 200, removeMember(db, teamId, Number(seg[4])));
        }
      }

      // Кто написал боту: чтобы привязать человека, не выспрашивая у него chat_id.
      if (req.method === 'GET' && p === '/api/telegram/contacts') {
        const { getUpdates } = await import('../adapters/telegram.js');
        const updates = await getUpdates();
        const seen = new Map();
        for (const u of updates) {
          const from = u.message?.from || u.my_chat_member?.from;
          const chat = u.message?.chat || u.my_chat_member?.chat;
          if (!from || !chat) continue;
          seen.set(String(chat.id), {
            chat_id: String(chat.id),
            name: [from.first_name, from.last_name].filter(Boolean).join(' '),
            username: from.username || null,
          });
        }
        return json(res, 200, [...seen.values()]);
      }

      // Проверка связи: шлём человеку тестовое сообщение.
      if (req.method === 'POST' && p === '/api/telegram/test') {
        const { chat_id } = await readJson(req);
        const { sendMessage } = await import('../adapters/telegram.js');
        try {
          await sendMessage(chat_id, 'Проверка связи: уведомления по лидам будут приходить сюда.');
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 200, { ok: false, error: String(err.message || err) });
        }
      }

      if (req.method === 'GET' && seg[1] === 'teams' && seg[3] === 'history') {
        return json(res, 200, teamHistory(db, Number(seg[2])));
      }

      if (req.method === 'GET' && p === '/api/queues') {
        return json(res, 200, KINDS.map((kind) => ({
          kind,
          cursor: db.prepare('SELECT cursor FROM queue_state WHERE kind = ?').get(kind)?.cursor ?? 0,
          priority: db.prepare(
            'SELECT p.*, t.name team_name FROM queue_priority p JOIN teams t ON t.id = p.team_id WHERE p.kind = ? AND p.consumed_at IS NULL ORDER BY p.id'
          ).all(kind),
          preview: queuePreview(db, kind, 8),
        })));
      }

      if (req.method === 'GET' && p === '/api/stats') return json(res, 200, stats(db));

      if (req.method === 'GET' && p === '/api/events') {
        return json(res, 200, db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 200').all());
      }

      if (req.method === 'GET' && p === '/api/outbox') {
        return json(res, 200, db.prepare(
          'SELECT id, event, state, attempts, last_error, created_at, sent_at FROM webhook_outbox ORDER BY id DESC LIMIT 100'
        ).all());
      }

      // ---- действия ----
      if (req.method === 'POST' && p === '/api/dispatch') return json(res, 200, dispatchQueue(db));

      if (req.method === 'POST' && p === '/api/enrich') {
        const { enrichPending } = await import('../core/enrichment.js');
        return json(res, 200, await enrichPending(db));
      }

      if (req.method === 'POST' && p === '/api/deliver') {
        const { deliverPending } = await import('../core/argusDelivery.js');
        return json(res, 200, await deliverPending(db));
      }

      if (req.method === 'POST' && p === '/api/import') {
        if (!importNow) return json(res, 501, { error: 'источник не настроен' });
        return json(res, 200, await importNow());
      }

      if (req.method === 'POST' && p === '/api/import/rows') {
        const body = await readJson(req); // ручная заливка строк / тесты
        return json(res, 200, importBatch(db, body, getConfig()));
      }

      if (req.method === 'GET' && p === '/api/columns') {
        const cfg = getConfig();
        return json(res, 200, {
          sheet: cfg.sheet, firstDataRow: cfg.firstDataRow, columns: cfg.columns,
          leadTypes: cfg.leadTypes, statuses: cfg.statuses, statusColumn: cfg.statusColumn,
        });
      }

      if (req.method === 'POST' && seg[1] === 'leads' && seg[3]) {
        const id = Number(seg[2]);
        const body = await readJson(req);
        switch (seg[3]) {
          case 'assign':
            return json(res, 200, body.team_id
              ? assignManually(db, id, Number(body.team_id))
              : assignNext(db, id) || { escalated: true });
          case 'in-work':  return json(res, 200, markInWork(db, id));
          case 'decline':  return json(res, 200, markDeclined(db, id, body.reason || 'отказ вручную'));
          case 'release':  releaseFromQuarantine(db, id); return json(res, 200, { ok: true });
          case 'escalate': escalate(db, id, body.reason || 'вручную'); return json(res, 200, { ok: true });
          case 'kind':
            db.prepare('UPDATE leads SET kind = ? WHERE id = ?').run(body.kind, id);
            return json(res, 200, { ok: true });
        }
      }

      // ---- команды ----
      if (req.method === 'POST' && p === '/api/teams') {
        const b = await readJson(req);
        const order = b.queue_order ?? (activeTeams(db).length + 1);
        const info = db.prepare('INSERT INTO teams (name, queue_order, argus_user_id) VALUES (?, ?, ?)')
          .run(b.name, order, b.argus_user_id ?? null);
        const id = Number(info.lastInsertRowid);
        logTeamChange(db, id, 'team_created', { name: b.name, queue_order: order });
        return json(res, 200, { id });
      }

      if (req.method === 'PATCH' && seg[1] === 'teams' && seg[2]) {
        const b = await readJson(req);
        const fields = [];
        const values = [];
        for (const [k, v] of Object.entries(b)) {
          if (!['name', 'queue_order', 'active', 'argus_user_id'].includes(k)) continue;
          fields.push(`${k} = ?`);
          values.push(v);
        }
        const teamId = Number(seg[2]);
        if (fields.length) {
          const before = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
          db.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?`).run(...values, teamId);
          const after = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
          logTeamChange(db, teamId, 'team_changed', {
            was: { name: before.name, queue_order: before.queue_order, active: before.active },
            now: { name: after.name, queue_order: after.queue_order, active: after.active },
          });
        }
        return json(res, 200, { ok: true });
      }

      // ---- статика ----
      if (req.method === 'GET' && !p.startsWith('/api')) {
        const file = p === '/' ? 'index.html' : p.slice(1);
        try {
          const body = await readFile(join(PUBLIC_DIR, file));
          // правки видны сразу: ни браузер, ни Cloudflare не держат старую версию
          res.writeHead(200, {
            'content-type': MIME[extname(file)] || 'application/octet-stream',
            'cache-control': 'no-store, must-revalidate',
          });
          return res.end(body);
        } catch { /* провалимся в 404 */ }
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: String(err.message || err) });
    }
  };
}

const decorate = (db) => (lead) => ({
  ...lead,
  raw: JSON.parse(lead.raw || '{}'),
  // сколько часов компания висит в текущем состоянии — видно, что залежалось
  age_hours: lead.status_changed_at
    ? Math.max(0, Math.round((Date.now() - Date.parse(lead.status_changed_at + 'Z')) / 36e5 * 10) / 10)
    : null,
  team_name: lead.assigned_team
    ? db.prepare('SELECT name FROM teams WHERE id = ?').get(lead.assigned_team)?.name ?? null
    : null,
  assignments: db.prepare(
    'SELECT a.*, t.name team_name FROM assignments a JOIN teams t ON t.id = a.team_id WHERE a.lead_id = ? ORDER BY a.id'
  ).all(lead.id),
});

export function stats(db) {
  const byStatus = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) c FROM leads GROUP BY status').all().map((r) => [r.status, r.c])
  );
  const byKind = Object.fromEntries(
    db.prepare("SELECT kind, COUNT(*) c FROM leads WHERE kind IS NOT NULL GROUP BY kind").all().map((r) => [r.kind, r.c])
  );
  const byTeam = db.prepare(`
    SELECT t.id, t.name, t.queue_order, t.active, t.argus_user_id,
      SUM(CASE WHEN a.state = 'pending'  THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN a.state = 'in_work'  THEN 1 ELSE 0 END) in_work,
      SUM(CASE WHEN a.state = 'declined' THEN 1 ELSE 0 END) declined,
      COUNT(a.id) total
    FROM teams t LEFT JOIN assignments a ON a.team_id = t.id
    GROUP BY t.id ORDER BY t.queue_order, t.id`).all();
  const outbox = Object.fromEntries(
    db.prepare('SELECT state, COUNT(*) c FROM webhook_outbox GROUP BY state').all().map((r) => [r.state, r.c])
  );
  const sheet = Object.fromEntries(
    db.prepare('SELECT state, COUNT(*) c FROM sheet_writes GROUP BY state').all().map((r) => [r.state, r.c])
  );
  const argus = Object.fromEntries(
    db.prepare("SELECT argus_state, COUNT(*) c FROM leads WHERE argus_state != 'idle' GROUP BY argus_state")
      .all().map((r) => [r.argus_state, r.c])
  );
  // что вообще подключено — интерфейс по этому гасит недоступные кнопки
  const config = {
    // таблица считается подключённой только если есть и id, и ключ на диске
    sheets: !!process.env.SHEETS_SPREADSHEET_ID
      && !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON
      && existsSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    argus: !!process.env.ARGUS_API_URL,
    b24: !!process.env.B24_WEBHOOK_URL,
  };
  return { leads: byStatus, kinds: byKind, teams: byTeam, outbox, sheet_writes: sheet, argus, config };
}
