// Телеграм-бот уведомлений: отправить текст в личку, ответить на нажатие кнопки, поменять кнопки под сообщением.
// Токен: TELEGRAM_BOT_TOKEN. Без него уведомления копятся в очереди и никуда не идут.
const API = 'https://api.telegram.org';

export const telegramEnabled = () => Boolean(process.env.TELEGRAM_BOT_TOKEN);

export async function sendMessage(chatId, text, { fetchImpl = fetch, replyMarkup, replyTo } = {}) {
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
      // Цитата исходного уведомления. Если его уже удалили — уходит без цитаты, а не падает.
      ...(replyTo ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {}),
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

/** Ответ на нажатие кнопки: всплывашка или короткий тост. Без ответа телеграм крутит часики. */
export async function answerCallback(callbackId, { text, alert = false, fetchImpl = fetch } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !callbackId) return false;
  const res = await fetchImpl(`${API}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, ...(text ? { text } : {}), show_alert: alert }),
  });
  const data = await res.json().catch(() => ({}));
  return Boolean(data.ok);
}

/** Поменять кнопки под уже отправленным сообщением (например, погасить «Взял в работу»). */
export async function editReplyMarkup(chatId, messageId, replyMarkup, { fetchImpl = fetch } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !messageId) return false;
  const res = await fetchImpl(`${API}/bot${token}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId), reply_markup: replyMarkup ?? { inline_keyboard: [] } }),
  });
  const data = await res.json().catch(() => ({}));
  return Boolean(data.ok);
}

/** Список команд бота (меню по «/»). Ставится один раз при старте. */
export async function setCommands(commands, { fetchImpl = fetch } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const res = await fetchImpl(`${API}/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands }),
  });
  const data = await res.json().catch(() => ({}));
  return Boolean(data.ok);
}
