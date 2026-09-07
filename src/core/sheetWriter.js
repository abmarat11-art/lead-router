// Обратная запись в таблицу: напротив компании в колонке статуса ставим «назначено».
// Очередь с ретраями — квоты Sheets API и сетевые сбои не должны терять пометки.
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const MAX_ATTEMPTS = 5;

/** Пока схема таблицы не согласована, ставим SHEET_READONLY=1: пометки копятся, но наружу не уходят. */
export const sheetReadonly = () => process.env.SHEET_READONLY === '1';

export async function flushSheetWrites(db, { limit = 20, write } = {}) {
  if (!write && sheetReadonly()) return { picked: 0, written: 0, failed: 0, readonly: true };
  const writer = write || (await import('../adapters/sheets.js')).writeBackStatus;
  const rows = db.prepare("SELECT * FROM sheet_writes WHERE state = 'pending' ORDER BY id LIMIT ?").all(limit);

  let written = 0, failed = 0;
  for (const row of rows) {
    const attempts = row.attempts + 1;
    try {
      await writer({ sourceKey: row.source_key, value: row.value, column: row.column_ref });
      db.prepare("UPDATE sheet_writes SET state = 'written', attempts = ?, written_at = ? WHERE id = ?")
        .run(attempts, nowIso(), row.id);
      written++;
    } catch (err) {
      failed++;
      db.prepare('UPDATE sheet_writes SET attempts = ?, state = ?, last_error = ? WHERE id = ?')
        .run(attempts, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', String(err.message || err), row.id);
    }
  }
  return { picked: rows.length, written, failed };
}
