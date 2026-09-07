// Проверка доступа к таблице: печатает первые строки с буквами колонок,
// чтобы заполнить config/columns.json по реальным данным, а не на глаз.
import { readFileSync } from 'node:fs';
import { getConfig, columnLetter } from '../src/core/columns.js';

try {
  const text = readFileSync('.env', 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env необязателен */ }

const cfg = getConfig();
const { fetchBatch } = await import('../src/adapters/sheets.js');

const rows = Number(process.argv[2] || 5);
const batch = await fetchBatch(cfg);
console.log(`лист "${cfg.sheet}", строк с данными: ${batch.rows.length}\n`);

for (const row of batch.rows.slice(0, rows)) {
  console.log(row.key);
  row.cells.forEach((value, i) => {
    if (String(value ?? '').trim()) console.log(`  ${columnLetter(i).padEnd(3)} ${value}`);
  });
  console.log('');
}
