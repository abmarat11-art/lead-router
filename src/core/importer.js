// Импорт строк из таблицы. Таблица — двусторонний канал:
// пустой статус = новая компания в очередь; «в работе» / «отказ» ставит СРМ,
// и мы обязаны это заметить на ближайшем проходе.
import { normalizeRow, normalizeStatus, rowHash } from './normalize.js';
import { loadConfig } from './columns.js';
import { markInWork, markDeclined, logEvent } from './queue.js';

const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

const LEAD_FIELDS = `company = ?, contact_name = ?, phone = ?, email = ?, lead_gen = ?,
  kind = ?, region = ?, raw = ?, dedup_key = ?, source_status = ?, b24_company_id = ?,
  source_hash = ?, updated_at = ?`;

const leadValues = (lead, hash) => [
  lead.company, lead.contact_name, lead.phone, lead.email, lead.lead_gen,
  lead.kind, lead.region, JSON.stringify(lead.raw), lead.dedup_key,
  lead.source_status, lead.b24_company_id, hash, nowIso(),
];

/**
 * @param {{rows: {key: string, cells: any[]}[]}} batch
 * @param {object} [config] схема колонок; по умолчанию config/columns.json
 */
export function importBatch(db, batch, config = loadConfig()) {
  const stats = { seen: 0, created: 0, updated: 0, skipped: 0, quarantined: 0, duplicates: 0, in_work: 0, declined: 0 };

  const findByKey = db.prepare('SELECT * FROM leads WHERE source_key = ?');
  const findDup = db.prepare(
    'SELECT id FROM leads WHERE dedup_key = ? AND dedup_key IS NOT NULL AND source_key != ?'
  );

  for (const row of batch.rows) {
    stats.seen++;
    const hash = rowHash(row.cells);
    const existing = findByKey.get(row.key);
    const { lead, problems } = normalizeRow(row.cells, config);

    if (existing) {
      if (existing.source_hash === hash) { stats.skipped++; continue; }

      // строку изменили: либо лидген поправил данные, либо СРМ выставила статус
      db.prepare(`UPDATE leads SET ${LEAD_FIELDS} WHERE id = ?`).run(...leadValues(lead, hash), existing.id);
      logEvent(db, { leadId: existing.id, kind: 'source_row_changed', data: { source_key: row.key, status: lead.source_status } });
      stats.updated++;

      const before = normalizeStatus(existing.source_status, config);
      const after = normalizeStatus(lead.source_status, config);
      if (after !== before) {
        if (after === 'in_work') { markInWork(db, existing.id); stats.in_work++; }
        if (after === 'declined') { markDeclined(db, existing.id, 'отказ в таблице'); stats.declined++; }
      }
      continue;
    }

    // новая строка: распределяем только те, где статус пустой
    const status = normalizeStatus(lead.source_status, config);
    if (lead.dedup_key && findDup.get(lead.dedup_key, row.key)) {
      problems.push('дубль: такая компания уже есть');
      stats.duplicates++;
    }

    const leadStatus = problems.length ? 'quarantine'
      : status === 'in_work' ? 'in_work'
      : status === 'declined' ? 'rejected'   // фрод: строка закрыта, в очередь не идёт
      : status ? 'assigned'                  // строка уже помечена кем-то — не трогаем
      : 'new';

    // есть id компании из Б24 — карточку и компанию в Аргусе заводим до раздачи
    const needsEnrich = leadStatus === 'new' && !!lead.b24_company_id;

    const info = db.prepare(`INSERT INTO leads
      (source_key, source_hash, company, contact_name, phone, email, lead_gen, kind,
       region, raw, dedup_key, source_status, b24_company_id, enrich_state, status, quarantine_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.key, hash, lead.company, lead.contact_name, lead.phone, lead.email,
           lead.lead_gen, lead.kind, lead.region, JSON.stringify(lead.raw),
           lead.dedup_key, lead.source_status, lead.b24_company_id,
           needsEnrich ? 'pending' : 'ready', leadStatus,
           problems.length ? problems.join('; ') : null);

    const id = Number(info.lastInsertRowid);
    logEvent(db, { leadId: id, kind: leadStatus === 'quarantine' ? 'quarantined' : 'imported', data: { problems } });
    if (leadStatus === 'quarantine') stats.quarantined++; else stats.created++;
  }

  return stats;
}

// Строку из карантина вернули в работу после правки в шите.
export function releaseFromQuarantine(db, leadId) {
  db.prepare("UPDATE leads SET status = 'new', quarantine_reason = NULL, updated_at = ? WHERE id = ? AND status = 'quarantine'")
    .run(nowIso(), leadId);
  logEvent(db, { leadId, kind: 'quarantine_released' });
}
