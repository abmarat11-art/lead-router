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
  return db;
}

export function openMigrated(path) {
  return migrate(openDb(path));
}
