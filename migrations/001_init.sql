-- Контур распределения лидов. Схема v2: назначение на команду, две независимые очереди.

CREATE TABLE IF NOT EXISTS teams (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  queue_order   INTEGER NOT NULL DEFAULT 0, -- место в очереди по умолчанию: 1,2,3,4
  -- id ответственного в Аргусе: с ним компания заводится на команду
  argus_user_id TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Курсор круговой очереди. Своя строка на каждый вид: лиды и встречи не пересекаются.
CREATE TABLE IF NOT EXISTS queue_state (
  kind    TEXT PRIMARY KEY,                 -- lead | meeting
  cursor  INTEGER NOT NULL DEFAULT 0        -- queue_order команды, которая получила последней
);

-- Долги: команда получила фрод вместо своего хода, компенсируем вне очереди.
CREATE TABLE IF NOT EXISTS queue_priority (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  team_id     INTEGER NOT NULL REFERENCES teams(id),
  lead_id     INTEGER REFERENCES leads(id),   -- фрод, из-за которого возник долг
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at TEXT,
  closed_lead_id INTEGER REFERENCES leads(id) -- компания, которой долг погасили
);
CREATE INDEX IF NOT EXISTS idx_priority_open ON queue_priority(kind, consumed_at, id);

CREATE TABLE IF NOT EXISTS leads (
  id             INTEGER PRIMARY KEY,
  source_key     TEXT NOT NULL UNIQUE,      -- лист:номер строки
  source_hash    TEXT NOT NULL,             -- хеш строки: правки задним числом видно
  company        TEXT,
  contact_name   TEXT,
  phone          TEXT,
  email          TEXT,
  lead_gen       TEXT,
  kind           TEXT,                      -- lead | meeting: разные очереди
  region         TEXT,
  raw            TEXT NOT NULL DEFAULT '{}',
  dedup_key      TEXT,
  source_status  TEXT,                      -- что сейчас написано в колонке «статус» шита
  b24_company_id TEXT,                      -- id компании в Б24 из таблицы
  b24_snapshot   TEXT,                      -- карточка из Б24 целиком, чтобы не дёргать его дважды
  argus_company_id TEXT,                    -- id компании в Аргусе после создания
  -- pending (нужно подтянуть из Б24) | ready | failed
  enrich_state   TEXT NOT NULL DEFAULT 'ready',
  enrich_error   TEXT,
  enrich_attempts INTEGER NOT NULL DEFAULT 0,
  -- доставка в Аргус: idle | pending (назначено, ждём отправки) | sent | failed
  argus_state    TEXT NOT NULL DEFAULT 'idle',
  argus_error    TEXT,
  argus_attempts INTEGER NOT NULL DEFAULT 0,
  -- new | assigned | in_work | rejected (фрод) | escalated | quarantine
  status         TEXT NOT NULL DEFAULT 'new',
  assigned_team  INTEGER REFERENCES teams(id),
  decline_count  INTEGER NOT NULL DEFAULT 0,   -- сколько раз строку отметили фродом
  quarantine_reason TEXT,
  imported_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_kind   ON leads(kind, status);
CREATE INDEX IF NOT EXISTS idx_leads_dedup  ON leads(dedup_key);
CREATE INDEX IF NOT EXISTS idx_leads_enrich ON leads(enrich_state, status);
CREATE INDEX IF NOT EXISTS idx_leads_argus  ON leads(argus_state);

-- Журнал назначений: кому отдали и чем закончилось.
CREATE TABLE IF NOT EXISTS assignments (
  id          INTEGER PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id),
  team_id     INTEGER NOT NULL REFERENCES teams(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- pending (ждём ответа СРМ) | in_work | declined | cancelled
  state       TEXT NOT NULL DEFAULT 'pending',
  resolved_at TEXT,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_assign_lead  ON assignments(lead_id, state);
CREATE INDEX IF NOT EXISTS idx_assign_state ON assignments(state);

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id              INTEGER PRIMARY KEY,
  event           TEXT NOT NULL,            -- lead.assigned | lead.in_work | lead.declined | lead.escalated
  payload         TEXT NOT NULL,
  url             TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  state           TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON webhook_outbox(state, next_attempt_at);

-- Очередь обратной записи в таблицу: пишем «назначено» напротив компании.
CREATE TABLE IF NOT EXISTS sheet_writes (
  id          INTEGER PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id),
  source_key  TEXT NOT NULL,
  column_ref  TEXT NOT NULL,                    -- буква колонки: статус или «долг закрыт»
  value       TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending',   -- pending | written | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  written_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sheet_writes_state ON sheet_writes(state, id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER REFERENCES leads(id),
  team_id    INTEGER REFERENCES teams(id),
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);
