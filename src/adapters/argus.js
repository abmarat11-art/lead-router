// Аргус (СРМ): создание компании и проверка, нет ли её уже.
// Диспетчер устроен как у Б24: адрес несёт личность и права,
// тело оборачивается в fields/filter, ответ приходит конвертом.
//   ARGUS_API_URL=https://crm-mvp.cloudplus.uz/api/rest/v1/<userPublicId>/<token>
const RATE_LIMIT_PAUSE_MS = 2000;   // потолок 60 запросов в минуту на ключ

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
  if (data.error) throw new Error(`Аргус ${method}: ${data.error_description || data.error}`);
  if (!res.ok) throw new Error(`Аргус ${method}: HTTP ${res.status}`);
  return data.result;
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');

// ОКЭД приходит из Б24 как «14120 - Производство спецодежды», а Аргус ждёт код.
export const okedCode = (raw) => {
  const match = String(raw ?? '').trim().match(/^\d+/);
  return match ? match[0] : null;
};

/** Компания с таким ИНН уже заведена? Возвращает её ID или null. */
export async function findCompanyByInn(inn, opts = {}) {
  if (!inn) return null;
  const list = await call('companies.list', { filter: { INN: inn } }, opts);
  // фильтр серверный, но сверяем сами: вдруг вернулось лишнее
  const found = (list || []).find((c) => digits(c.INN) === digits(inn));
  return found ? String(found.ID) : null;
}

/**
 * Завести компанию. Поля — как в Аргусе: TITLE и INN обязательны,
 * ORGINFO/OKED/CONTACT_* заполняем из карточки Б24.
 * @param {object} company карточка из adapters/bitrix.js
 */
export async function createCompany(company, opts = {}) {
  if (!company.title) throw new Error('в карточке Б24 нет названия компании (TITLE)');
  if (!company.inn) throw new Error('в карточке Б24 нет ИНН — Аргус без него компанию не заведёт');

  const phones = [];
  const emails = [];
  for (const contact of company.contacts || []) {
    for (const p of contact.phones || []) phones.push({ VALUE: p, VALUE_TYPE: 'WORK' });
    for (const e of contact.emails || []) emails.push({ VALUE: e, VALUE_TYPE: 'WORK' });
  }
  const [contact] = company.contacts || [];

  const fields = {
    TITLE: company.title,
    INN: company.inn,
    ORGINFO: company.orginfo_url || undefined,
    OKED: okedCode(company.oked) || undefined,
    PHONE: phones.length ? phones : undefined,
    EMAIL: emails.length ? emails : undefined,
    // контакт заводится и привязывается к компании, если передать имя
    CONTACT_NAME: contact?.full_name || undefined,
    CONTACT_PHONE: contact?.phone || contact?.phones?.[0] || undefined,
    CONTACT_EMAIL: contact?.email || contact?.emails?.[0] || undefined,
  };

  const result = await call('companies.add', { fields }, opts);
  const id = result?.ID ?? result?.id ?? (typeof result === 'string' ? result : null);
  if (!id) throw new Error('Аргус companies.add не вернул ID компании');
  return String(id);
}

/** Есть — берём существующую, нет — заводим. */
export async function ensureCompany(company, opts = {}) {
  const existing = await findCompanyByInn(company.inn, opts);
  if (existing) return { id: existing, created: false };
  return { id: await createCompany(company, opts), created: true };
}
