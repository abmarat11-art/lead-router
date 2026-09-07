// Обратная запись в таблицу: напротив компании в колонке статуса ставим «назначено».
// Очередь с ретраями — квоты Sheets API и сетевые сбои не должны терять пометки.
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const MAX_ATTEMPTS = 5;

export async function flushSheetWrites(db, { limit = 20, write } = {}) {
  const writer = write || (await import('../adapters/sheets.js')).writeBackStatus;
  const rows = db.prepare("SELECT * FROM sheet_writes WHERE state = 'pending' ORDER BY id LIMIT ?").all(limit);

  let written = 0, failed = 0;
  for (const row of rows) {
    const attempts = row.attempts + 1;
    try {
      await writer({ sourceKey: row.source_key, value: row.value });
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
