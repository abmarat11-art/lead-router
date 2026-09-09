// Фидбэк по лидогенерации из телеграм-мини-аппа.
// Кто пишет — не спрашиваем: телеграм подписывает данные о человеке токеном бота,
// подпись проверяем у себя. Подделать автора нельзя, вводить логин не нужно.
import { createHmac, timingSafeEqual } from 'node:crypto';

const INITDATA_TTL_SEC = 24 * 60 * 60;

const equalHex = (a, b) => {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/**
 * Проверить initData мини-аппа. Возвращает объект пользователя телеграма или null.
 * Алгоритм телеграма: подписывается строка «ключ=значение» по алфавиту, ключом
 * служит HMAC от токена бота со словом WebAppData.
 */
export function verifyInitData(initData, { token = process.env.TELEGRAM_BOT_TOKEN, now = Date.now() } = {}) {
  if (!initData || !token) return null;
  const params = new URLSearchParams(String(initData));
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  if (!equalHex(createHmac('sha256', secret).update(check).digest('hex'), hash)) return null;

  // Просроченная подпись — чужой скриншот адресной строки, а не живое окно.
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || (now / 1000 - authDate) > INITDATA_TTL_SEC) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch { return null; }
}

/** Кто это в наших командах. Незнакомый телеграм фидбэк оставлять не может. */
export function identify(db, user) {
  if (!user) return null;
  const member = db.prepare(`
    SELECT m.*, t.name team_name FROM team_members m JOIN teams t ON t.id = m.team_id
    WHERE m.telegram_chat_id = ? LIMIT 1`).get(String(user.id));
  if (!member) return null;
  return {
    member,
    name: member.name || [user.first_name, user.last_name].filter(Boolean).join(' ') || member.argus_user_id,
  };
}

/** Шапка окна: по какой компании пишем. Без lead_id — свободный фидбэк. */
export function leadContext(db, leadId) {
  if (!leadId) return null;
  const lead = db.prepare(`
    SELECT l.id, l.company, l.kind, l.lead_gen, t.name team_name
    FROM leads l LEFT JOIN teams t ON t.id = l.assigned_team WHERE l.id = ?`).get(Number(leadId));
  return lead || null;
}

const MAX_LEN = 4000;

export function addFeedback(db, { who, leadId = null, text }) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('пустой фидбэк не сохраняем');
  if (clean.length > MAX_LEN) throw new Error(`слишком длинно: максимум ${MAX_LEN} символов`);

  const lead = leadId ? leadContext(db, leadId) : null;
  const info = db.prepare(
    'INSERT INTO feedback (lead_id, team_id, member_id, chat_id, author, text) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(lead ? lead.id : null, who.member.team_id, who.member.id,
    String(who.member.telegram_chat_id), who.name, clean.slice(0, MAX_LEN));
  return { id: Number(info.lastInsertRowid), lead_id: lead ? lead.id : null };
}

const SELECT_FEEDBACK = `
  SELECT f.*, l.company, l.kind, l.lead_gen, l.b24_company_id, l.argus_company_id, t.name team_name
  FROM feedback f
  LEFT JOIN leads l ON l.id = f.lead_id
  LEFT JOIN teams t ON t.id = f.team_id`;

export function listFeedback(db, { limit = 200 } = {}) {
  return db.prepare(`${SELECT_FEEDBACK} ORDER BY f.id DESC LIMIT ?`).all(limit).map((r) => withLinks(db, r));
}

/** Один фидбэк по ссылке, которой поделились. */
export function getFeedback(db, id) {
  const row = db.prepare(`${SELECT_FEEDBACK} WHERE f.id = ?`).get(Number(id));
  return row ? withLinks(db, row) : null;
}

// Ссылки на карточки компании считаем на сервере: шаблоны живут в .env, а не в браузере.
const companyUrl = (tpl, id) => (tpl && id ? tpl.replace('{id}', id) : null);

function withLinks(db, row) {
  return {
    ...row,
    b24_url: companyUrl(process.env.B24_COMPANY_URL, row.b24_company_id),
    argus_url: companyUrl(process.env.ARGUS_COMPANY_URL, row.argus_company_id),
    // Свободный фидбэк часто приходит со ссылкой на компанию прямо в тексте —
    // достаём её оттуда, иначе привязка теряется и карточка выглядит пустой.
    mentions: mentionedCompanies(db, row.text, { skipLeadId: row.lead_id }),
  };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Из шаблона ссылки делаем распознаватель: {id} — это и есть номер компании. */
function urlMatcher(tpl) {
  if (!tpl || !tpl.includes('{id}')) return null;
  return new RegExp(escapeRe(tpl).replace(escapeRe('{id}'), '([A-Za-z0-9_-]+)'), 'g');
}

/**
 * Компании, упомянутые ссылками в тексте фидбэка. Если такая компания у нас есть —
 * подтягиваем её карточку целиком: название, лидоген, команду и обе ссылки.
 */
export function mentionedCompanies(db, text, { skipLeadId = null } = {}) {
  const sources = [
    { source: 'b24', column: 'b24_company_id', re: urlMatcher(process.env.B24_COMPANY_URL) },
    { source: 'argus', column: 'argus_company_id', re: urlMatcher(process.env.ARGUS_COMPANY_URL) },
  ];

  const found = new Map();
  for (const { source, column, re } of sources) {
    if (!re) continue;
    for (const m of String(text ?? '').matchAll(re)) {
      const ref = m[1];
      if (found.has(`${source}:${ref}`)) continue;
      const lead = db.prepare(`
        SELECT l.id, l.company, l.kind, l.lead_gen, l.status, l.b24_company_id, l.argus_company_id,
               t.name team_name
        FROM leads l LEFT JOIN teams t ON t.id = l.assigned_team
        WHERE l.${column} = ? ORDER BY l.id DESC LIMIT 1`).get(ref);
      if (lead && lead.id === skipLeadId) continue;   // это и есть компания фидбэка, не дублируем
      found.set(`${source}:${ref}`, {
        source,
        ref,
        url: m[0],
        lead_id: lead?.id ?? null,
        company: lead?.company ?? null,
        lead_gen: lead?.lead_gen ?? null,
        team_name: lead?.team_name ?? null,
        status: lead?.status ?? null,
        b24_url: companyUrl(process.env.B24_COMPANY_URL, lead?.b24_company_id ?? (source === 'b24' ? ref : null)),
        argus_url: companyUrl(process.env.ARGUS_COMPANY_URL, lead?.argus_company_id ?? (source === 'argus' ? ref : null)),
      });
    }
  }
  return [...found.values()];
}
