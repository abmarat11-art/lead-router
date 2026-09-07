// Аргус (СРМ): создание компании и проверка, нет ли её уже.
// База URL включает токен, поэтому лежит только в .env:
//   ARGUS_API_URL=https://crm-mvp.cloudplus.uz/api/rest/v1/<id>/<token>
const base = () => {
  const url = process.env.ARGUS_API_URL;
  if (!url) throw new Error('ARGUS_API_URL не задан');
  return url.replace(/\/$/, '');
};

async function call(method, { params = {}, body, fetchImpl = fetch } = {}) {
  const query = new URLSearchParams(params).toString();
  const res = await fetchImpl(`${base()}/${method}${query ? `?${query}` : ''}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(`Аргус ${method}: ${data.error_description || data.error}`);
  if (!res.ok) throw new Error(`Аргус ${method}: HTTP ${res.status}`);
  return data.result;
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');

/** Компания с таким ИНН уже заведена? Возвращает её ID или null. */
export async function findCompanyByInn(inn, opts = {}) {
  if (!inn) return null;
  const list = await call('companies.list', { params: { INN: inn }, ...opts });
  // фильтр на стороне Аргуса не работает — сверяем сами
  const found = (list || []).find((c) => digits(c.INN) === digits(inn));
  return found ? String(found.ID) : null;
}

/**
 * Завести компанию. Поля — как в самом Аргусе: TITLE, INN, PHONE[], EMAIL, WEB, ADDRESS.
 * @param {object} company карточка из Б24 (см. adapters/bitrix.js)
 */
export async function createCompany(company, opts = {}) {
  const phones = [];
  const emails = [];
  for (const contact of company.contacts || []) {
    for (const p of contact.phones || []) phones.push({ VALUE: p, VALUE_TYPE: 'WORK' });
    for (const e of contact.emails || []) emails.push({ VALUE: e, VALUE_TYPE: 'WORK' });
  }

  const payload = {
    TITLE: company.title,
    INN: company.inn || undefined,
    WEB: company.orginfo_url || undefined,   // ссылка на ОргИнфо
    OKED: company.oked || undefined,         // Аргус поле игнорирует, если его нет
    PHONE: phones.length ? phones : undefined,
    EMAIL: emails.length ? emails : undefined,
    COMMENTS: company.contacts?.length
      ? 'Контакты из Б24: ' + company.contacts.map((c) => [c.full_name, c.phone].filter(Boolean).join(' ')).join('; ')
      : undefined,
  };

  const result = await call('companies.add', { body: payload, ...opts });
  const id = result?.ID ?? result?.id ?? result;
  if (!id) throw new Error('Аргус companies.add не вернул ID компании');
  return String(id);
}

/** Есть — берём существующую, нет — заводим. */
export async function ensureCompany(company, opts = {}) {
  const existing = await findCompanyByInn(company.inn, opts);
  if (existing) return { id: existing, created: false };
  return { id: await createCompany(company, opts), created: true };
}
