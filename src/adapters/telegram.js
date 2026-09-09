// Телеграм-бот уведомлений. Умеет ровно одно — отправить текст в личку человеку.
// Токен: TELEGRAM_BOT_TOKEN. Без него уведомления копятся в очереди и никуда не идут.
const API = 'https://api.telegram.org';

export const telegramEnabled = () => Boolean(process.env.TELEGRAM_BOT_TOKEN);

export async function sendMessage(chatId, text, { fetchImpl = fetch, replyMarkup } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');

  const res = await fetchImpl(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(`Телеграм: ${data.description || `HTTP ${res.status}`}`);
    // 403 — человек не нажимал «Старт» у бота: бот не может писать первым.
    err.code = data.error_code ?? res.status;
    throw err;
  }
  return data.result;
}

/** Кто написал боту — чтобы привязать человека к команде по его chat_id. */
export async function getUpdates(offset = 0, { fetchImpl = fetch } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return [];
  const res = await fetchImpl(`${API}/bot${token}/getUpdates?offset=${offset}&timeout=0`);
  const data = await res.json().catch(() => ({}));
  return data.ok ? data.result : [];
}

/**
 * Кнопка «Фидбэк» в меню бота — свободный отзыв без привязки к компании.
 * Ставится один раз при старте: телеграм помнит её сам.
 */
export async function setMenuButton(url, { fetchImpl = fetch } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !url) return false;
  const res = await fetchImpl(`${API}/bot${token}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      menu_button: { type: 'web_app', text: 'Фидбэк', web_app: { url } },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return Boolean(data.ok);
}
