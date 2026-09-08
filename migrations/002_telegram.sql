-- Очередь telegram-уведомлений. Тот же outbox-подход, что у вебхуков:
-- сначала в базу, потом воркер с ретраями — молчание телеграма не ломает раздачу.
CREATE TABLE IF NOT EXISTS tg_outbox (
  id              INTEGER PRIMARY KEY,
  lead_id         INTEGER REFERENCES leads(id),
  team_id         INTEGER REFERENCES teams(id),
  member_id       INTEGER,
  chat_id         TEXT NOT NULL,
  text            TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  state           TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tg_outbox_state ON tg_outbox(state, next_attempt_at);

-- Кто написал боту. Копим у себя: getUpdates отдаёт события только 24 часа,
-- а человек мог нажать «Старт» задолго до того, как его вписали в команду.
CREATE TABLE IF NOT EXISTS tg_contacts (
  chat_id    TEXT PRIMARY KEY,
  name       TEXT,
  username   TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Курсор getUpdates: без него телеграм отдаёт одно и то же по кругу.
CREATE TABLE IF NOT EXISTS tg_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_update_id INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO tg_state (id, last_update_id) VALUES (1, 0);
