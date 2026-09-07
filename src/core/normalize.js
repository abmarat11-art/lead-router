// Приведение сырых строк таблицы к нашей схеме.
// Колонки в шите зовутся по-разному — маппинг задаётся синонимами заголовков.
import { createHash } from 'node:crypto';

export const COLUMN_SYNONYMS = {
  company:      ['компания', 'организация', 'название компании', 'company'],
  contact_name: ['контакт', 'фио', 'имя', 'контактное лицо', 'contact'],
  phone:        ['телефон', 'номер', 'phone', 'тел'],
  email:        ['почта', 'email', 'e-mail'],
  lead_gen:     ['лидогенератор', 'лидген', 'ответственный', 'кто нашёл', 'кто нашел', 'менеджер'],
  outcome_type: ['итог', 'результат', 'тип', 'итог работы', 'outcome'],
  lang:         ['язык', 'язык клиента', 'lang', 'language'],
  region:       ['регион', 'город', 'область', 'region'],
  comment:      ['комментарий', 'примечание', 'заметка', 'comment'],
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Заголовки шита -> индексы наших полей. Неопознанные колонки не теряем: они уходят в raw.
export function mapHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const key = norm(h);
    for (const [field, variants] of Object.entries(COLUMN_SYNONYMS)) {
      if (variants.some((v) => key === v || key.startsWith(v))) {
        if (map[field] === undefined) map[field] = i;
      }
    }
  });
  return map;
}

export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  if (digits.length === 9) return `+998${digits}`;              // узбекский без кода страны
  if (digits.length === 11 && /^[78]/.test(digits)) return `+7${digits.slice(1)}`;
  return `+${digits}`;
}

const LANGS = {
  ru: ['ru', 'рус', 'русский', 'russian'],
  uz: ['uz', 'узб', 'узбекский', 'uzbek', 'ozbek'],
  en: ['en', 'англ', 'английский', 'english'],
};

export function normalizeLang(raw) {
  const v = norm(raw);
  if (!v) return null;
  for (const [code, variants] of Object.entries(LANGS)) {
    if (variants.some((x) => v.startsWith(x))) return code;
  }
  return v.slice(0, 8);
}

export function normalizeOutcome(raw) {
  const v = norm(raw);
  if (!v) return null;
  if (v.includes('встреч') || v.includes('meeting')) return 'meeting';
  if (v.includes('лид') || v.includes('lead')) return 'lead';
  return v.slice(0, 32);
}

export function rowHash(cells) {
  return createHash('sha1').update(cells.map((c) => String(c ?? '')).join('')).digest('hex');
}

// Строка -> черновик лида + список проблем (пустой список = можно распределять).
export function normalizeRow(cells, headerMap, headers) {
  const at = (field) => (headerMap[field] === undefined ? null : cells[headerMap[field]] ?? null);
  const raw = {};
  headers.forEach((h, i) => { if (String(cells[i] ?? '').trim()) raw[h] = cells[i]; });

  const lead = {
    company: (at('company') || '').trim() || null,
    contact_name: (at('contact_name') || '').trim() || null,
    phone: normalizePhone(at('phone')),
    email: (at('email') || '').trim().toLowerCase() || null,
    lead_gen: (at('lead_gen') || '').trim() || null,
    outcome_type: normalizeOutcome(at('outcome_type')),
    lang: normalizeLang(at('lang')),
    region: (at('region') || '').trim() || null,
    raw,
  };
  lead.dedup_key = lead.phone
    || (lead.email ? `mail:${lead.email}` : null)
    || (lead.company ? `co:${norm(lead.company)}` : null);

  const problems = [];
  if (!lead.company && !lead.contact_name) problems.push('нет ни компании, ни контакта');
  if (!lead.phone && !lead.email) problems.push('нет телефона и почты');
  if (!lead.outcome_type) problems.push('не указан итог работы');

  return { lead, problems };
}
