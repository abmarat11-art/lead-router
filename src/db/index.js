import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function openDb(path = process.env.DB_PATH || join(ROOT, 'data', 'lead-router.db')) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function migrate(db) {
  db.exec(readFileSync(join(ROOT, 'migrations', '001_init.sql'), 'utf8'));
  db.exec(readFileSync(join(ROOT, 'migrations', '002_telegram.sql'), 'utf8'));
  // Колонки добавляем отдельно: ALTER TABLE не умеет IF NOT EXISTS,
  // а migrate() выполняется на каждом старте.
  addColumn(db, 'team_members', 'telegram_chat_id', 'TEXT');
  return db;
}

function addColumn(db, table, column, type) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function openMigrated(path) {
  return migrate(openDb(path));
}
