// Импорт строк из источника в БД: дедуп, карантин кривых строк, лог правок.
import { mapHeaders, normalizeRow, rowHash } from './normalize.js';

const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function logEvent(db, leadId, kind, data = {}) {
  db.prepare('INSERT INTO events (lead_id, kind, data) VALUES (?, ?, ?)')
    .run(leadId, kind, JSON.stringify(data));
}

/**
 * @param {object} db
 * @param {{headers: string[], rows: {key: string, cells: any[]}[]}} batch
 */
export function importBatch(db, batch, { defaultTeamId = null } = {}) {
  const headerMap = mapHeaders(batch.headers);
  const stats = { seen: 0, created: 0, updated: 0, skipped: 0, quarantined: 0, duplicates: 0 };

  const findByKey = db.prepare('SELECT * FROM leads WHERE source_key = ?');
  const findDup = db.prepare(
    'SELECT id FROM leads WHERE dedup_key = ? AND dedup_key IS NOT NULL AND source_key != ?'
  );

  for (const row of batch.rows) {
    stats.seen++;
    const hash = rowHash(row.cells);
    const existing = findByKey.get(row.key);

    if (existing) {
      if (existing.source_hash === hash) { stats.skipped++; continue; }
      // строку поправили задним числом: обновляем данные, но назначение не трогаем
      const { lead } = normalizeRow(row.cells, headerMap, batch.headers);
      db.prepare(`UPDATE leads SET company = ?, contact_name = ?, phone = ?, email = ?,
                    lead_gen = ?, outcome_type = ?, lang = ?, region = ?, raw = ?,
                    dedup_key = ?, source_hash = ?, updated_at = ? WHERE id = ?`)
        .run(lead.company, lead.contact_name, lead.phone, lead.email, lead.lead_gen,
             lead.outcome_type, lead.lang, lead.region, JSON.stringify(lead.raw),
             lead.dedup_key, hash, nowIso(), existing.id);
      logEvent(db, existing.id, 'source_row_changed', { source_key: row.key });
      stats.updated++;
      continue;
    }

    const { lead, problems } = normalizeRow(row.cells, headerMap, batch.headers);

    if (lead.dedup_key && findDup.get(lead.dedup_key, row.key)) {
      problems.push('дубль: такой клиент уже есть');
      stats.duplicates++;
    }

    const status = problems.length ? 'quarantine' : 'new';
    const info = db.prepare(`INSERT INTO leads
      (source_key, source_hash, company, contact_name, phone, email, lead_gen, outcome_type,
       lang, region, raw, dedup_key, status, team_id, quarantine_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.key, hash, lead.company, lead.contact_name, lead.phone, lead.email,
           lead.lead_gen, lead.outcome_type, lead.lang, lead.region,
           JSON.stringify(lead.raw), lead.dedup_key, status, defaultTeamId,
           problems.length ? problems.join('; ') : null);

    const id = Number(info.lastInsertRowid);
    logEvent(db, id, status === 'quarantine' ? 'quarantined' : 'imported', { problems });
    if (status === 'quarantine') stats.quarantined++; else stats.created++;
  }

  return stats;
}

// Строку из карантина вернули в работу вручную после правки в шите.
export function releaseFromQuarantine(db, leadId) {
  db.prepare("UPDATE leads SET status = 'new', quarantine_reason = NULL, updated_at = ? WHERE id = ? AND status = 'quarantine'")
    .run(nowIso(), leadId);
  logEvent(db, leadId, 'quarantine_released');
}
