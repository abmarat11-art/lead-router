// Источник строк: Google Sheets. Контракт источника — { headers, rows: [{key, cells}] }.
// Ключ строки = лист + номер строки, поэтому правки задним числом видно по хешу.
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let cachedClient = null;

function client() {
  if (cachedClient) return cachedClient;
  const path = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!path) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON не задан');
  const key = JSON.parse(readFileSync(path, 'utf8'));
  cachedClient = new JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES });
  return cachedClient;
}

async function api(path, init = {}) {
  const auth = client();
  const { token } = await auth.getAccessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchBatch(cfg, { spreadsheetId = process.env.SHEETS_SPREADSHEET_ID } = {}) {
  if (!spreadsheetId) throw new Error('SHEETS_SPREADSHEET_ID не задан');
  const range = `${cfg.sheet}!A1:ZZ100000`;
  const data = await api(`${spreadsheetId}/values/${encodeURIComponent(range)}`);
  return toBatch(data.values || [], cfg);
}

// Чистая функция — её же используют тесты и ручная заливка.
// Ключ строки — лист + номер строки в таблице, поэтому смещений не бывает.
export function toBatch(values, cfg) {
  const first = cfg.firstDataRow ?? 2;
  const rows = values
    .map((cells, i) => ({ key: `${cfg.sheet}:${i + 1}`, cells, row: i + 1 }))
    .filter((r) => r.row >= first && r.cells.some((c) => String(c ?? '').trim()))
    .map(({ key, cells }) => ({ key, cells }));
  return { rows };
}

// Обратная запись в шит: ставим статус напротив компании в её же строке.
export async function writeBackStatus({
  spreadsheetId = process.env.SHEETS_SPREADSHEET_ID,
  sourceKey,
  column,
  value,
}) {
  if (!column || !spreadsheetId) throw new Error('не задана колонка статуса или SHEETS_SPREADSHEET_ID');
  const parts = String(sourceKey).split(':');
  const rowNumber = parts.pop();
  const sheetName = parts.join(':');
  const range = `${sheetName}!${column}${rowNumber}`;
  await api(`${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ range, majorDimension: 'ROWS', values: [[value]] }),
  });
  return true;
}
