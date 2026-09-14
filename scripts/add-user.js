// Завести пользователя интерфейса: node scripts/add-user.js <логин> "<Имя>"
// Пароль генерируется и печатается один раз; в файл ложится только хеш.
// Повторный вызов с тем же логином — новый пароль.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashPassword, usersFile, loadUsers } from '../src/http/auth.js';

const [login, name] = process.argv.slice(2);
if (!login || !/^[a-z0-9._-]{3,}$/i.test(login)) {
  console.error('логин: латиница/цифры/точка, от 3 символов. Пример: node scripts/add-user.js v.pak "Владимир Пак"');
  process.exit(1);
}
// без похожих символов (0/O, 1/l/I), чтобы читалось с экрана телефона
const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const password = Array.from(randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');

const users = loadUsers();
users[login] = { name: name || login, ...hashPassword(password), created_at: new Date().toISOString() };
mkdirSync(dirname(usersFile()), { recursive: true });
writeFileSync(usersFile(), JSON.stringify(users, null, 2) + '\n');
console.log(JSON.stringify({ login, name: users[login].name, password }));
