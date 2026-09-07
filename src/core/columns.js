// Схема таблицы: жёсткая привязка полей к номерам колонок.
// Никакого угадывания по заголовкам — что в конфиге, то и читаем.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUIRED = ['company', 'phone', 'lead_type', 'status'];
const KNOWN = ['company', 'contact_name', 'phone', 'email', 'lead_gen', 'region', 'lead_type', 'status'];

export const DEFAULT_CONFIG = {
  sheet: 'Лист1',
  firstDataRow: 2,
  columns: { company: 'B', contact_name: 'C', phone: 'D', lead_gen: 'E', lead_type: 'F', status: 'G' },
  leadTypes: { lead: 'лид', meeting: 'встреча' },
  statuses: { assigned: 'назначено', in_work: 'в работе', declined: 'отказ' },
};

// "A" -> 0, "C" -> 2, "AA" -> 26; число 3 -> 2 (колонки в конфиге считаются с единицы).
export function columnIndex(ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref) || ref < 1) throw new Error(`номер колонки должен быть целым от 1: ${ref}`);
    return ref - 1;
  }
  const letters = String(ref).trim().toUpperCase();
  if (/^\d+$/.test(letters)) return columnIndex(Number(letters));
  if (!/^[A-Z]+$/.test(letters)) throw new Error(`не понимаю колонку "${ref}": нужна буква (C) или номер (3)`);
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export const columnLetter = (index) => {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/** Конфиг -> индексы колонок (0-based) + проверка обязательных полей. */
export function resolveConfig(raw = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...raw,
    columns: { ...(raw.columns || DEFAULT_CONFIG.columns) },
    leadTypes: { ...DEFAULT_CONFIG.leadTypes, ...(raw.leadTypes || {}) },
    statuses: { ...DEFAULT_CONFIG.statuses, ...(raw.statuses || {}) },
  };

  const index = {};
  for (const field of KNOWN) index[field] = columnIndex(cfg.columns[field] ?? null);

  const missing = REQUIRED.filter((f) => index[f] === null);
  if (missing.length) throw new Error(`в config/columns.json не заданы обязательные колонки: ${missing.join(', ')}`);

  const seen = new Map();
  for (const [field, i] of Object.entries(index)) {
    if (i === null) continue;
    if (seen.has(i)) throw new Error(`колонка ${columnLetter(i)} указана дважды: ${seen.get(i)} и ${field}`);
    seen.set(i, field);
  }

  return { ...cfg, index, statusColumn: columnLetter(index.status) };
}

export function loadConfig(path = process.env.COLUMNS_CONFIG || join(ROOT, 'config', 'columns.json')) {
  if (!existsSync(path)) return resolveConfig(DEFAULT_CONFIG);
  return resolveConfig(JSON.parse(readFileSync(path, 'utf8')));
}

let cached = null;
/** Кэшированный конфиг для фоновых циклов; setConfig подменяет его в тестах. */
export function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}
export function setConfig(cfg) {
  cached = cfg ? resolveConfig(cfg) : null;
  return cached;
}
