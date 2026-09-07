// HTTP API поверх node:http — без фреймворка, роутов немного.
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  offerLead, acceptOffer, declineOffer, dispatchQueue, assignManually, escalate,
} from '../core/router.js';
import { releaseFromQuarantine, importBatch } from '../core/importer.js';

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
        const rows = status
          ? db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY imported_at DESC LIMIT 500').all(status)
          : db.prepare('SELECT * FROM leads ORDER BY imported_at DESC LIMIT 500').all();
        return json(res, 200, rows.map(withOffer(db)));
      }

      if (req.method === 'GET' && p === '/api/teams') {
        const teams = db.prepare('SELECT * FROM teams ORDER BY id').all();
        return json(res, 200, teams.map((t) => ({
          ...t,
          members: db.prepare('SELECT * FROM employees WHERE team_id = ? ORDER BY queue_order, id').all(t.id)
            .map((e) => ({ ...e, langs: JSON.parse(e.langs || '[]') })),
        })));
      }

      if (req.method === 'GET' && p === '/api/stats') return json(res, 200, stats(db));

      if (req.method === 'GET' && p === '/api/events') {
        return json(res, 200, db.prepare(
          'SELECT * FROM events ORDER BY id DESC LIMIT 200'
        ).all());
      }

      if (req.method === 'GET' && p === '/api/outbox') {
        return json(res, 200, db.prepare(
          'SELECT id, event, state, attempts, last_error, created_at, sent_at FROM webhook_outbox ORDER BY id DESC LIMIT 100'
        ).all());
      }

      // ---- действия ----
      if (req.method === 'POST' && p === '/api/dispatch') return json(res, 200, dispatchQueue(db));

      if (req.method === 'POST' && p === '/api/import') {
        if (!importNow) return json(res, 501, { error: 'источник не настроен' });
        return json(res, 200, await importNow());
      }

      if (req.method === 'POST' && p === '/api/import/rows') {
        const body = await readJson(req); // { headers, rows } — ручная загрузка/тесты
        return json(res, 200, importBatch(db, body, { defaultTeamId: body.team_id ?? null }));
      }

      if (req.method === 'POST' && seg[1] === 'leads' && seg[3]) {
        const id = Number(seg[2]);
        const body = await readJson(req);
        switch (seg[3]) {
          case 'offer':   return json(res, 200, offerLead(db, id) || { escalated: true });
          case 'assign':  assignManually(db, id, Number(body.employee_id)); return json(res, 200, { ok: true });
          case 'release': releaseFromQuarantine(db, id); return json(res, 200, { ok: true });
          case 'escalate': escalate(db, id, body.reason || 'вручную'); return json(res, 200, { ok: true });
          case 'team':
            db.prepare('UPDATE leads SET team_id = ? WHERE id = ?').run(Number(body.team_id), id);
            return json(res, 200, { ok: true });
        }
      }

      if (req.method === 'POST' && seg[1] === 'offers' && seg[3]) {
        const id = Number(seg[2]);
        const body = await readJson(req);
        if (seg[3] === 'accept') return json(res, 200, acceptOffer(db, id));
        if (seg[3] === 'decline') return json(res, 200, declineOffer(db, id, body.reason || null));
      }

      // ---- справочники ----
      if (req.method === 'POST' && p === '/api/teams') {
        const b = await readJson(req);
        const info = db.prepare('INSERT INTO teams (name, strategy) VALUES (?, ?)')
          .run(b.name, b.strategy || 'round_robin');
        return json(res, 200, { id: Number(info.lastInsertRowid) });
      }

      if (req.method === 'POST' && p === '/api/employees') {
        const b = await readJson(req);
        const info = db.prepare(
          'INSERT INTO employees (team_id, name, tg_username, langs, daily_limit, queue_order) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(b.team_id ?? null, b.name, b.tg_username ?? null,
              JSON.stringify(b.langs || []), b.daily_limit ?? 0, b.queue_order ?? 0);
        return json(res, 200, { id: Number(info.lastInsertRowid) });
      }

      if (req.method === 'PATCH' && seg[1] === 'employees' && seg[2]) {
        const b = await readJson(req);
        const fields = [];
        const values = [];
        for (const [k, v] of Object.entries(b)) {
          if (!['name', 'team_id', 'tg_username', 'tg_user_id', 'langs', 'daily_limit', 'queue_order', 'active'].includes(k)) continue;
          fields.push(`${k} = ?`);
          values.push(k === 'langs' ? JSON.stringify(v) : v);
        }
        if (fields.length) db.prepare(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`).run(...values, Number(seg[2]));
        return json(res, 200, { ok: true });
      }

      // ---- статика ----
      if (req.method === 'GET' && !p.startsWith('/api')) {
        const file = p === '/' ? 'index.html' : p.slice(1);
        try {
          const body = await readFile(join(PUBLIC_DIR, file));
          res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
          return res.end(body);
        } catch { /* провалимся в 404 */ }
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: String(err.message || err) });
    }
  };
}

const withOffer = (db) => (lead) => ({
  ...lead,
  raw: JSON.parse(lead.raw || '{}'),
  offer: db.prepare(
    "SELECT o.*, e.name employee_name FROM offers o JOIN employees e ON e.id = o.employee_id WHERE o.lead_id = ? AND o.state = 'pending'"
  ).get(lead.id) || null,
});

export function stats(db) {
  const byStatus = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) c FROM leads GROUP BY status').all().map((r) => [r.status, r.c])
  );
  const byEmployee = db.prepare(`
    SELECT e.id, e.name,
      SUM(CASE WHEN o.state = 'accepted' THEN 1 ELSE 0 END) accepted,
      SUM(CASE WHEN o.state = 'declined' THEN 1 ELSE 0 END) declined,
      SUM(CASE WHEN o.state = 'expired'  THEN 1 ELSE 0 END) expired,
      SUM(CASE WHEN o.state = 'pending'  THEN 1 ELSE 0 END) pending
    FROM employees e LEFT JOIN offers o ON o.employee_id = e.id
    GROUP BY e.id ORDER BY e.queue_order, e.id`).all();
  const outbox = Object.fromEntries(
    db.prepare('SELECT state, COUNT(*) c FROM webhook_outbox GROUP BY state').all().map((r) => [r.state, r.c])
  );
  return { leads: byStatus, employees: byEmployee, outbox };
}
