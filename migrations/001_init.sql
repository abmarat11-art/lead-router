-- Контур распределения лидов. Схема v1.

CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  active      INTEGER NOT NULL DEFAULT 1,
  -- стратегия выдачи: round_robin | balance (у кого меньше в работе)
  strategy    TEXT NOT NULL DEFAULT 'round_robin',
  rr_cursor   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY,
  team_id       INTEGER REFERENCES teams(id),
  name          TEXT NOT NULL,
  tg_user_id    TEXT UNIQUE,
  tg_username   TEXT,
  link_code     TEXT,              -- разовый код привязки телеграма
  langs         TEXT NOT NULL DEFAULT '[]',  -- JSON: ["ru","uz"]
  daily_limit   INTEGER NOT NULL DEFAULT 0,  -- 0 = без лимита
  queue_order   INTEGER NOT NULL DEFAULT 0,  -- очередность внутри команды
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id             INTEGER PRIMARY KEY,
  -- ключ строки-источника: лист+номер строки, чтобы не импортировать дважды
  source_key     TEXT NOT NULL UNIQUE,
  source_hash    TEXT NOT NULL,     -- хеш содержимого строки: правки задним числом видно
  company        TEXT,
  contact_name   TEXT,
  phone          TEXT,
  email          TEXT,
  lead_gen       TEXT,              -- кто нашёл
  outcome_type   TEXT,              -- lead | meeting
  lang           TEXT,
  region         TEXT,
  raw            TEXT NOT NULL DEFAULT '{}',   -- вся строка как есть
  dedup_key      TEXT,              -- нормализованный телефон/домен
  -- new | queued | offered | assigned | escalated | quarantine
  status         TEXT NOT NULL DEFAULT 'new',
  team_id        INTEGER REFERENCES teams(id),
  assigned_to    INTEGER REFERENCES employees(id),
  decline_count  INTEGER NOT NULL DEFAULT 0,
  quarantine_reason TEXT,
  imported_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_dedup  ON leads(dedup_key);

CREATE TABLE IF NOT EXISTS offers (
  id           INTEGER PRIMARY KEY,
  lead_id      INTEGER NOT NULL REFERENCES leads(id),
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  offered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  -- pending | accepted | declined | expired | cancelled
  state        TEXT NOT NULL DEFAULT 'pending',
  reason       TEXT,               -- причина отказа
  responded_at TEXT,
  tg_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_offers_state ON offers(state);
CREATE INDEX IF NOT EXISTS idx_offers_lead  ON offers(lead_id);

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id            INTEGER PRIMARY KEY,
  event         TEXT NOT NULL,     -- lead.assigned | lead.declined | lead.escalated
  payload       TEXT NOT NULL,
  url           TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- pending | sent | failed
  state         TEXT NOT NULL DEFAULT 'pending',
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON webhook_outbox(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  lead_id     INTEGER REFERENCES leads(id),
  employee_id INTEGER REFERENCES employees(id),
  kind        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);
