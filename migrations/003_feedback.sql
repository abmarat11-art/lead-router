-- Фидбэк из мини-аппа: замечания и предложения по лидогенерации.
-- lead_id пустой — это свободный фидбэк, вызванный кнопкой меню без привязки к компании.
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER REFERENCES leads(id),
  team_id    INTEGER REFERENCES teams(id),
  member_id  INTEGER,
  chat_id    TEXT NOT NULL,
  author     TEXT,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_lead ON feedback(lead_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
