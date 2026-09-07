// Б24: тянем карточку компании и её контакты по id из таблицы.
// Работает через входящий вебхук: B24_WEBHOOK_URL вида
// https://portal.bitrix24.ru/rest/1/xxxxxxxx/
const FIELDS = {
  title: 'TITLE',
  inn: 'UF_CRM_64DB2D1742285',
  innLegacy: 'UF_CRM_UZB_INN_COMPANY',   // у старых карточек ИНН лежит здесь
  orginfo: 'UF_CRM_1754989588',
  oked: 'UF_CRM_1754990395249',
};

async function call(method, params = {}, { fetchImpl = fetch } = {}) {
  const base = process.env.B24_WEBHOOK_URL;
  if (!base) throw new Error('B24_WEBHOOK_URL не задан');
  const res = await fetchImpl(`${base.replace(/\/$/, '')}/${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Б24 ${method}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Б24 ${method}: ${data.error_description || data.error}`);
  return data.result;
}

const firstValue = (multi) => (Array.isArray(multi) && multi.length ? multi[0].VALUE : null);
const allValues = (multi) => (Array.isArray(multi) ? multi.map((x) => x.VALUE).filter(Boolean) : []);

/** Карточка компании + её контакты в том виде, в каком уйдут в Аргус. */
export async function fetchCompany(companyId, opts = {}) {
  const company = await call('crm.company.get', { id: companyId }, opts);
  if (!company) throw new Error(`компания ${companyId} не найдена в Б24`);

  const links = await call('crm.company.contact.items.get', { id: companyId }, opts).catch(() => []);
  const contacts = [];
  for (const link of links || []) {
    const c = await call('crm.contact.get', { id: link.CONTACT_ID }, opts).catch(() => null);
    if (!c) continue;
    contacts.push({
      b24_id: String(c.ID),
      name: c.NAME || null,
      last_name: c.LAST_NAME || null,
      second_name: c.SECOND_NAME || null,
      full_name: [c.LAST_NAME, c.NAME, c.SECOND_NAME].filter(Boolean).join(' ') || null,
      phone: firstValue(c.PHONE),
      phones: allValues(c.PHONE),
      email: firstValue(c.EMAIL),
      emails: allValues(c.EMAIL),
    });
  }

  return {
    b24_id: String(company.ID),
    title: company[FIELDS.title] || null,
    inn: company[FIELDS.inn] || company[FIELDS.innLegacy] || null,
    orginfo_url: company[FIELDS.orginfo] || null,
    oked: company[FIELDS.oked] || null,
    contacts,
  };
}

export { FIELDS as B24_FIELDS };
