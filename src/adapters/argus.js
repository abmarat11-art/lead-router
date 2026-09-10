// Аргус (СРМ): создание компании и проверка, нет ли её уже.
// Диспетчер устроен как у Б24: адрес несёт личность и права,
// тело оборачивается в fields/filter, ответ приходит конвертом.
//   ARGUS_API_URL=https://crm-mvp.cloudplus.uz/api/rest/v1/<userPublicId>/<token>
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RATE_LIMIT_PAUSE_MS = 2000;   // потолок 60 запросов в минуту на ключ

const DEFAULT_FIELDS = {
  fields: { assignedBy: 'ASSIGNED_BY_ID', kind: 'LEAD_TYPE', notify: 'NOTIFY_USER_IDS' },
  // Поле-список: у подписи («Лид») админ может поменять текст, ключ — нет.
  kindValues: { lead: 'lead', meeting: 'meeting' },
};

let fieldConfig = null;
/** Имена полей Аргуса — из config/argus.json, чтобы переименование не лезло в код. */
export function argusFields() {
  if (fieldConfig) return fieldConfig;
  const path = process.env.ARGUS_FIELDS_CONFIG || join(ROOT, 'config', 'argus.json');
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  fieldConfig = {
    fields: { ...DEFAULT_FIELDS.fields, ...(raw.fields || {}) },
    kindValues: { ...DEFAULT_FIELDS.kindValues, ...(raw.kindValues || {}) },
  };
  return fieldConfig;
}
export const setArgusFields = (cfg) => { fieldConfig = cfg ? { ...DEFAULT_FIELDS, ...cfg } : null; };

const base = () => {
  const url = process.env.ARGUS_API_URL;
  if (!url) throw new Error('ARGUS_API_URL не задан');
  return url.replace(/\/$/, '');
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, body = {}, { fetchImpl = fetch, retries = 1 } = {}) {
  const res = await fetchImpl(`${base()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 429 && retries > 0) {
    await sleep(RATE_LIMIT_PAUSE_MS);
    return call(method, body, { fetchImpl, retries: retries - 1 });
  }

  const data = await res.json().catch(() => ({}));
  if (data.error || !res.ok) {
    const err = new Error(`Аргус ${method}: ${data.error_description || data.error || `HTTP ${res.status}`}`);
    err.status = res.status;
    err.argusError = data.error || null;
    throw err;
  }
  return data.result;
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');

const isUnknownReference = (err) => /справочник/i.test(String(err.message || ''));

// Аргус называет виноватого в тексте: «такого сотрудника нет в этом направлении: petrov».
// Если это кто-то из списка уведомлений, а не сам получатель — лид важнее уведомления.
function blamesNotifyOnly(err, fields, notifyKey, assignedKey) {
  const text = String(err.message || '').toLowerCase();
  if (!/сотрудник/.test(text)) return false;
  const assigned = String(fields[assignedKey] ?? '').toLowerCase();
  if (assigned && text.includes(assigned)) return false;
  const list = [].concat(fields[notifyKey] ?? []).map((v) => String(v).toLowerCase());
  return list.some((id) => text.includes(id));
}

// ОКЭД в Аргусе — обычное текстовое поле, а не справочник:
// что пришло из Б24, то и кладём («14120 - Производство спецодежды»).
export const okedText = (raw) => {
  const text = String(raw ?? '').trim();
  return text || null;
};

/** Компания с таким ИНН уже заведена? Возвращает её карточку или null. */
export async function findCompanyByInn(inn, opts = {}) {
  if (!inn) return null;
  const list = await call('companies.list', { filter: { INN: inn } }, opts);
  // фильтр серверный, но сверяем сами: вдруг вернулось лишнее
  return (list || []).find((c) => digits(c.INN) === digits(inn)) || null;
}

/**
 * Кто ведёт компанию в Аргусе.
 * Возвращает id ответственного, null — поля в ответе нет (Аргус его пока не отдаёт).
 * Это не то же самое, что «ответственного нет»: неизвестность трактуем осторожно.
 */
export function companyResponsible(record) {
  const { fields } = argusFields();
  const value = record?.[fields.assignedBy];
  const id = String(value ?? '').trim();
  return id || null;
}

/**
 * Завести компанию сразу на ответственного команды.
 * TITLE и INN обязательны, ORGINFO/OKED/CONTACT_* — из карточки Б24.
 * @param {object} company карточка из adapters/bitrix.js
 * @param {{assignedById?: string, kind?: 'lead'|'meeting'}} placement кому и с каким типом
 */
export async function createCompany(company, placement = {}, opts = {}) {
  if (!company.title) throw new Error('в карточке Б24 нет названия компании (TITLE)');
  if (!company.inn) throw new Error('в карточке Б24 нет ИНН — Аргус без него компанию не заведёт');

  const phones = [];
  const emails = [];
  for (const contact of company.contacts || []) {
    for (const p of contact.phones || []) phones.push({ VALUE: p, VALUE_TYPE: 'WORK' });
    for (const e of contact.emails || []) emails.push({ VALUE: e, VALUE_TYPE: 'WORK' });
  }
  const fields = {
    TITLE: company.title,
    INN: company.inn,
    ORGINFO: company.orginfo_url || undefined,
    OKED: okedText(company.oked) || undefined,
    PHONE: phones.length ? phones : undefined,
    EMAIL: emails.length ? emails : undefined,
    // Контактные лица здесь не передаются: с ff159e5 в Аргусе появились contacts.*,
    // и человек заводится отдельной карточкой (см. syncContacts ниже).
  };

  Object.assign(fields, placementFields(placement));

  const { fields: names } = argusFields();
  let result;
  try {
    result = await call('companies.add', { fields }, opts);
  } catch (err) {
    // ОКЭД — свободный текст, но если Аргус вдруг заупрямится,
    // компанию не теряем: заводим без него, дозаполнят руками.
    if (fields.OKED && isUnknownReference(err)) {
      delete fields.OKED;
      result = await call('companies.add', { fields }, opts);
    } else if (blamesNotifyOnly(err, fields, names.notify, names.assignedBy)) {
      // Кто-то из списка уведомлений неизвестен Аргусу — лид всё равно должен доехать.
      delete fields[names.notify];
      result = await call('companies.add', { fields }, opts);
      result = { ...result, notifyDropped: String(err.message || err) };
    } else throw err;
  }
  const id = result?.ID ?? result?.id ?? (typeof result === 'string' ? result : null);
  if (!id) throw new Error('Аргус companies.add не вернул ID компании');
  return String(id);
}

// ── Контакты ────────────────────────────────────────────────────────────────
// Контакт в Аргусе — отдельная сущность, а не поле компании: один человек может
// числиться в нескольких компаниях, у компании — сколько угодно людей.
// COMPANY_ID обязателен везде, кроме contacts.get.

/** Телефоны контакта в формате Аргуса. Без телефона контакт не примут. */
const contactPhones = (contact) => {
  const list = contact.phones?.length ? contact.phones : [contact.phone].filter(Boolean);
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))]
    .map((VALUE) => ({ VALUE, VALUE_TYPE: 'WORK' }));
};

/**
 * Завести человека в карточке компании.
 * @param {string} companyId publicId компании
 * @param {object} contact карточка из adapters/bitrix.js
 * @param {{primary?: boolean}} opts_ главный контакт компании — ровно один
 */
export async function addContact(companyId, contact, { primary = false } = {}, opts = {}) {
  if (!companyId) throw new Error('contacts.add без COMPANY_ID: контакт живёт связью с компанией');
  const name = String(contact?.full_name || '').trim();
  if (!name) throw new Error('у контакта нет имени — Аргус его не примет');
  const phone = contactPhones(contact);
  if (!phone.length) throw new Error(`у контакта «${name}» нет телефона — Аргус требует хотя бы один`);

  const fields = {
    COMPANY_ID: companyId,
    NAME: name,
    PHONE: phone,
    EMAIL: contact.email || contact.emails?.[0] || undefined,
    IS_PRIMARY: primary ? 'Y' : undefined,
  };
  const result = await call('contacts.add', { fields }, opts);
  const id = result?.ID ?? result?.id ?? null;
  return id ? String(id) : null;
}

/** Все люди компании. */
export const listContacts = (companyId, opts = {}) =>
  call('contacts.list', { filter: { COMPANY_ID: companyId } }, opts);

/**
 * Завести всех контактных лиц компании: первый пригодный — главный.
 * Контакт — довесок к компании: его срыв не должен ронять уже заведённую строку,
 * поэтому ошибки собираются в отчёт, а не бросаются наружу.
 */
export async function syncContacts(companyId, contacts = [], opts = {}) {
  const report = { added: 0, skipped: 0, errors: [] };
  let primaryTaken = false;
  for (const contact of contacts) {
    try {
      await addContact(companyId, contact, { primary: !primaryTaken }, opts);
      primaryTaken = true;
      report.added++;
    } catch (err) {
      // Человек без имени или телефона — не ошибка интеграции, а неполная карточка в Б24.
      if (/нет имени|нет телефона/.test(String(err.message || ''))) report.skipped++;
      else report.errors.push(String(err.message || err));
    }
  }
  return report;
}

/** Поля назначения: кому и с каким типом. */
export function placementFields(placement = {}) {
  const { fields: names, kindValues } = argusFields();
  const out = {};
  if (placement.assignedById) out[names.assignedBy] = placement.assignedById;
  if (placement.kind && kindValues[placement.kind]) out[names.kind] = kindValues[placement.kind];

  // Список уведомляемых — добавка к назначению, без него Аргус ответит 400.
  // Получателя в список не кладём: своё уведомление он получает и так.
  const notify = (placement.notifyIds || [])
    .map((id) => String(id ?? '').trim())
    .filter((id) => id && id.toLowerCase() !== String(placement.assignedById ?? '').trim().toLowerCase());
  if (placement.assignedById && notify.length) out[names.notify] = [...new Set(notify)];
  return out;
}

/**
 * Сменить ответственного (и тип) у уже заведённой компании.
 * Присланное поле меняется, остальная карточка не трогается —
 * поэтому шлём только назначение, чтобы не затереть правки менеджеров.
 */
export async function assignCompany(id, placement = {}, opts = {}) {
  const fields = placementFields(placement);
  if (!Object.keys(fields).length) return false;
  await call('companies.update', { ID: id, fields }, opts);
  return true;
}

/**
 * Компании в Аргусе нет — заводим сразу на ответственного команды.
 * Компания уже есть — НЕ трогаем: у неё свой хозяин, отбирать её лидген не вправе.
 * Такая строка возвращается как matched, а решение (фрод, долг команде, сигнал
 * руководителю) принимает core/argusDelivery — адаптер в СРМ ничего не переписывает.
 *
 * Гонка (кто-то завёл компанию между поиском и созданием) отдаёт 409 по ИНН —
 * это тот же случай matched, а не ошибка строки.
 */
export async function ensureCompany(company, placement = {}, opts = {}) {
  const existing = await findCompanyByInn(company.inn, opts);
  if (existing) return matched(existing);
  // Сигнал наружу ровно в момент, когда компанию действительно заводим:
  // по нему вызывающий отличит свою компанию от чужой, если ответа не дождётся.
  await opts.onCreateAttempt?.();
  try {
    const id = await createCompany(company, placement, opts);
    // Компания заведена — заводим её людей. Сорвалось — компания всё равно наша.
    const contacts = await syncContacts(id, company.contacts || [], opts);
    return { id, created: true, matched: false, contacts };
  } catch (err) {
    if (err.status !== 409) throw err;
    const found = await findCompanyByInn(company.inn, opts);
    if (!found) throw err;
    return matched(found);
  }
}

const matched = (record) => ({
  id: String(record.ID),
  created: false,
  matched: true,
  responsible: companyResponsible(record),
  title: record.TITLE || null,
});
