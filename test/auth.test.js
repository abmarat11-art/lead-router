import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { withAuth, verifyToken } from '../src/http/auth.js';

const OK = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };

async function withServer(fn) {
  const server = createServer(withAuth(OK));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn((path, init = {}) => fetch(base + path, { redirect: 'manual', ...init }));
  } finally { server.close(); }
}

beforeEach(() => {
  process.env.AUTH_USER = 'admin';
  process.env.AUTH_PASSWORD = 'secret123';
  process.env.SESSION_SECRET = 'test-secret';
  process.env.COOKIE_SECURE = '0';
});
after(() => { delete process.env.AUTH_USER; delete process.env.AUTH_PASSWORD; });

const login = (call, user, password) => call('/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user, password }),
});

test('без входа API отвечает 401, а страница ведёт на форму', () => withServer(async (call) => {
  assert.equal((await call('/api/leads')).status, 401);
  const page = await call('/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');
}));

test('health и страница входа доступны без сессии', () => withServer(async (call) => {
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/login.html')).status, 200);
}));

test('верный логин выдаёт сессию, с ней API открывается', () => withServer(async (call) => {
  const res = await login(call, 'admin', 'secret123');
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /lr_session=/);
  assert.match(cookie, /HttpOnly/);

  const authed = await call('/api/leads', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(authed.status, 200);
}));

test('неверный пароль не пускает', () => withServer(async (call) => {
  const res = await login(call, 'admin', 'wrong');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
}));

test('подделанная кука не проходит', () => withServer(async (call) => {
  const fake = Buffer.from(`admin.${Date.now() + 1000}`).toString('base64url') + '.deadbeef';
  const res = await call('/api/leads', { headers: { cookie: `lr_session=${fake}` } });
  assert.equal(res.status, 401);
}));

test('просроченная сессия не принимается', () => {
  const expired = Buffer.from(`admin.${Date.now() - 1000}`).toString('base64url');
  assert.equal(verifyToken(`${expired}.нет-подписи`), null);
});

test('выход гасит куку', () => withServer(async (call) => {
  const res = await call('/api/logout');
  assert.match(res.headers.get('set-cookie'), /lr_session=; Path=\/; Max-Age=0/);
}));

test('без AUTH_USER защита не включается', () => {
  delete process.env.AUTH_USER;
  return withServer(async (call) => {
    assert.equal((await call('/api/leads')).status, 200);
  });
});
