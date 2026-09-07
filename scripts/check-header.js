// Печатает шапку таблицы с буквами колонок — по ней заполняется config/columns.json.
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env','utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'');
}
const { columnLetter } = await import('../src/core/columns.js');
const { JWT } = await import('google-auth-library');
const key = JSON.parse(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON,'utf8'));
const auth = new JWT({ email:key.client_email, key:key.private_key, scopes:['https://www.googleapis.com/auth/spreadsheets'] });
const { token } = await auth.getAccessToken();
const id = process.env.SHEETS_SPREADSHEET_ID;
const meta = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}`,{headers:{authorization:`Bearer ${token}`}})).json();
console.log('листы:', meta.sheets.map(s=>s.properties.title).join(' | '));
const r = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent('Лист1!A1:ZZ1')}`,{headers:{authorization:`Bearer ${token}`}})).json();
(r.values?.[0]||[]).forEach((v,i)=>console.log(`  ${columnLetter(i).padEnd(3)} ${v}`));
