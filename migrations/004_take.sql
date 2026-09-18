-- Кто взял компанию в работу кнопкой в телеграме. Одна компания — один взявший:
-- второе нажатие не перезаписывает первое, а показывает, кто уже взял.
CREATE TABLE IF NOT EXISTS lead_takes (
  lead_id   INTEGER PRIMARY KEY REFERENCES leads(id),
  team_id   INTEGER REFERENCES teams(id),
  member_id INTEGER,
  chat_id   TEXT NOT NULL,
  name      TEXT,
  taken_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
