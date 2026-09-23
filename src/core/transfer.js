// Перенос компании из Б24 в Аргус по ссылке из телеграма.
// Сотрудник присылает боту ссылку на карточку Б24 — компания и её контакты
// заводятся в Аргусе сразу на него. Очередь и команды здесь ни при чём:
// это ручной перенос своей компании, а не раздача лида.

const ASK_LINK = 'Пришлите ссылку на компанию в Б24 — как в адресной строке карточки, '
  + 'вида https://acrm.site/crm/company/details/123/';
const NOT_BOUND = 'Сначала привяжите свой ID Аргуса: пришлите его одним сообщением.';

/** Постоянная клавиатура под полем ввода: одна кнопка, чтобы не искать команду за «/». */
export function transferKeyboard() {
  const base = process.env.MINIAPP_URL?.replace(/\/$/, '');
  // С мини-аппом кнопка открывает окно с полем; без него — просто шлёт слово, и бот просит ссылку.
  const button = base ? { text: 'Перенос в Аргус', web_app: { url: `${base}/transfer.html` } } : { text: 'Перенос в Аргус' };
  return { keyboard: [[button]], resize_keyboard: true, is_persistent: true };
}

/** Из ссылки на карточку Б24 (или голого номера) достаём id компании. */
export function parseB24CompanyLink(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = s.match(/\/crm\/company\/details\/(\d+)/i) || s.match(/[?&]ID=(\d+)/i);
  if (m) return m[1];
  return /^\d{1,12}$/.test(s) ? s : null;
}

/** Ссылка на карточку Аргуса по шаблону из .env. */
export const argusLink = (id) =>
  process.env.ARGUS_COMPANY_URL ? process.env.ARGUS_COMPANY_URL.replace('{id}', id) : `#${id}`;

/**
 * Участник команды по чату телеграма: только привязанный может переносить.
 * Берём последнюю привязку: человек мог сперва прислать не тот ID (например свой
 * телеграмный), а потом настоящий — работать должен тот, что прислан последним.
 */
export function memberByChat(db, chatId) {
  return db.prepare(`
    SELECT m.*, t.name team_name FROM team_members m JOIN teams t ON t.id = m.team_id
    WHERE m.telegram_chat_id = ? AND m.active = 1 ORDER BY m.id DESC LIMIT 1`).get(String(chatId));
}

const WRONG_ID = (login) => `Аргус не знает сотрудника <b>${login}</b> — похоже, это не тот ID.\n\n`
  + 'Откройте свою страницу сотрудника в Аргусе, скопируйте ID кнопкой и пришлите его сюда одним сообщением. '
  + 'Телеграмный ID и почта не подойдут.';

/** Аргус ответил «такого сотрудника нет» — виноват привязанный ID, а не компания. */
const blamesEmployee = (err) => /сотрудник/i.test(String(err?.message || ''));

/** Режим «жду ссылку»: включается командой, гасится первой же ссылкой или любым другим текстом. */
export function setMode(db, chatId, mode) {
  db.prepare('UPDATE tg_contacts SET mode = ? WHERE chat_id = ?').run(mode, String(chatId));
}
export const getMode = (db, chatId) =>
  db.prepare('SELECT mode FROM tg_contacts WHERE chat_id = ?').get(String(chatId))?.mode || null;

function logEvent(db, kind, data) {
  db.prepare('INSERT INTO events (lead_id, team_id, kind, data) VALUES (NULL, ?, ?, ?)')
    .run(data.team_id ?? null, kind, JSON.stringify(data));
}

/**
 * Сама пересадка: Б24 → Аргус на отправителя. Возвращает текст ответа человеку.
 * Компания с таким ИНН уже есть — не трогаем и не переназначаем: у неё свой хозяин.
 * @param {{fetchCompany, ensureCompany}} deps подменяются в тестах
 */
export async function transferCompany(db, { chatId, b24Id }, deps = {}) {
  const member = memberByChat(db, chatId);
  if (!member) return NOT_BOUND;

  const bitrix = deps.fetchCompany || (await import('../adapters/bitrix.js')).fetchCompany;
  const ensure = deps.ensureCompany || (await import('../adapters/argus.js')).ensureCompany;

  let company;
  try {
    company = await bitrix(b24Id);
  } catch (err) {
    logEvent(db, 'bot_transfer_failed', { team_id: member.team_id, by: member.argus_user_id, b24_id: b24Id, error: String(err.message || err) });
    return `Не смог прочитать компанию ${b24Id} в Б24: ${err.message || err}`;
  }

  let res;
  try {
    res = await ensure(company, { assignedById: member.argus_user_id, kind: 'lead' });
  } catch (err) {
    logEvent(db, 'bot_transfer_failed', { team_id: member.team_id, by: member.argus_user_id, b24_id: b24Id, error: String(err.message || err) });
    // Сам себя привязал с опечаткой — снимаем привязку, чтобы человек прислал ID заново,
    // иначе он будет биться в одну и ту же ошибку на каждой ссылке.
    if (blamesEmployee(err) && member.role === 'notify' && member.team_name === 'Лидгены') {
      db.prepare("UPDATE team_members SET active = 0, updated_at = datetime('now') WHERE id = ?").run(member.id);
      return WRONG_ID(member.argus_user_id);
    }
    return `Аргус не принял «${company.title || b24Id}»: ${err.message || err}`;
  }

  const link = `<a href="${argusLink(res.id)}">${company.title || 'карточка'}</a>`;
  if (res.matched) {
    logEvent(db, 'bot_transfer_matched', { team_id: member.team_id, by: member.argus_user_id, b24_id: b24Id, argus_company_id: res.id, responsible: res.responsible || null });
    return `Компания с ИНН ${company.inn} уже есть в Аргусе: ${link}\nОтветственного не менял.`;
  }

  const c = res.contacts || { added: 0, skipped: 0, errors: [] };
  logEvent(db, 'bot_transfer', { team_id: member.team_id, by: member.argus_user_id, b24_id: b24Id, argus_company_id: res.id, contacts: c });
  let text = `Готово, ${link} заведена в Аргусе на вас.\nКонтактов перенесено: ${c.added}`;
  if (c.skipped) text += `, пропущено без имени/телефона: ${c.skipped}`;
  if (c.errors?.length) text += `\nНе удалось завести контактов: ${c.errors.length} (${c.errors[0]})`;
  return text;
}

/**
 * Шаг диалога. Возвращает { reply, handled } — handled=false значит текст не про перенос,
 * пусть его разбирает привязка по логину.
 */
export async function handleTransferText(db, chatId, text, deps = {}) {
  const clean = String(text ?? '').trim();
  const mode = getMode(db, chatId);

  if (/^\/transfer\b/i.test(clean) || /^перенос в аргус$/i.test(clean)) {
    if (!memberByChat(db, chatId)) return { handled: true, reply: NOT_BOUND };
    setMode(db, chatId, 'transfer');
    return { handled: true, reply: ASK_LINK };
  }

  const b24Id = parseB24CompanyLink(clean);
  // Ссылку принимаем и без команды: человек и так знает, зачем прислал.
  const isLink = b24Id && /\/crm\/company\//i.test(clean);
  if (mode !== 'transfer' && !isLink) return { handled: false };

  if (!b24Id) {
    if (clean.startsWith('/')) { setMode(db, chatId, null); return { handled: false }; }
    return { handled: true, reply: `Это не похоже на ссылку Б24. ${ASK_LINK}` };
  }
  setMode(db, chatId, null);
  return { handled: true, reply: await transferCompany(db, { chatId, b24Id }, deps) };
}
