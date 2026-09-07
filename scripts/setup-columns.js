// Разовая подготовка таблицы: заголовки системных колонок и чекбокс в колонке долга.
// Идемпотентно: если заголовки уже стоят, ничего не меняет.
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { getConfig } = await import('../src/core/columns.js');
const { JWT } = await import('google-auth-library');

const cfg = getConfig();
const id = process.env.SHEETS_SPREADSHEET_ID;
const key = JSON.parse(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'utf8'));
const auth = new JWT({ email: key.client_email, key: key.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const { token } = await auth.getAccessToken();

const api = async (path, init) => {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${await res.text()}`);
  return res.json();
};

const meta = await api('');
const sheet = meta.sheets.find((s) => s.properties.title === cfg.sheet);
if (!sheet) throw new Error(`лист "${cfg.sheet}" не найден`);
const sheetId = sheet.properties.sheetId;

const statusCol = cfg.index.status;
const debtCol = cfg.index.debt_closed;

const head = await api(`/values/${encodeURIComponent(`${cfg.sheet}!${cfg.statusColumn}1:${cfg.debtColumn}1`)}`);
const [status = '', debt = ''] = head.values?.[0] || [];
if (status && debt) {
  console.log(`заголовки уже стоят: ${cfg.statusColumn}="${status}", ${cfg.debtColumn}="${debt}"`);
} else {
  await api(`/values/${encodeURIComponent(`${cfg.sheet}!${cfg.statusColumn}1:${cfg.debtColumn}1`)}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values: [['Статус', 'Долг закрыт']] }) });
  console.log(`заголовки записаны: ${cfg.statusColumn}="Статус", ${cfg.debtColumn}="Долг закрыт"`);
}

// чекбокс на всю колонку долга, начиная со второй строки
await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{
  setDataValidation: {
    range: { sheetId, startRowIndex: 1, startColumnIndex: debtCol, endColumnIndex: debtCol + 1 },
    rule: { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true },
  },
}, {
  repeatCell: {
    range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: debtCol + 1 },
    cell: { userEnteredFormat: { textFormat: { bold: true } } },
    fields: 'userEnteredFormat.textFormat.bold',
  },
}] }) });
console.log(`чекбокс включён в колонке ${cfg.debtColumn}`);
