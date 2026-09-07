// Вход по логину и паролю. Пара берётся из окружения, пароль в коде не лежит.
// Сессия — подписанная кука, чтобы не гонять пароль в каждом запросе.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const COOKIE = 'lr_session';
const TTL_MS = 12 * 60 * 60 * 1000;   // 12 часов

let secret = null;
const sessionSecret = () => (secret ||= process.env.SESSION_SECRET || randomBytes(32).toString('hex'));

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const sign = (value) => createHmac('sha256', sessionSecret()).update(value).digest('hex');

function issueToken(user) {
  const payload = `${user}.${Date.now() + TTL_MS}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token) return null;
  const [encoded, signature] = String(token).split('.');
  if (!encoded || !signature) return null;
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  if (!safeEqual(signature, sign(payload))) return null;
  const [user, expires] = payload.split('.');
  return Number(expires) > Date.now() ? user : null;
}

const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((c) => c.trim().split('=')).filter(([k, v]) => k && v)
    .map(([k, ...rest]) => [k, rest.join('=')])
);

export const authEnabled = () => !!(process.env.AUTH_USER && process.env.AUTH_PASSWORD);

/**
 * Оборачивает обработчик проверкой сессии. Без AUTH_USER/AUTH_PASSWORD
 * защита не включается — локальная разработка остаётся без логина.
 */
export function withAuth(handler) {
  return async function guarded(req, res) {
    if (!authEnabled()) return handler(req, res);

    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const ok = safeEqual(body.user ?? '', process.env.AUTH_USER)
        && safeEqual(body.password ?? '', process.env.AUTH_PASSWORD);
      if (!ok) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'неверный логин или пароль' }));
      }
      const cookie = `${COOKIE}=${issueToken(body.user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}`
        + (process.env.COOKIE_SECURE === '0' ? '' : '; Secure');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname === '/api/logout') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname === '/health' || url.pathname === '/login.html') return handler(req, res);

    const user = verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
    if (!user) {
      if (url.pathname.startsWith('/api')) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'нужен вход' }));
      }
      res.writeHead(302, { location: '/login.html' });
      return res.end();
    }

    return handler(req, res);
  };
}
