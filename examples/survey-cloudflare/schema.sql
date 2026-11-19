CREATE TABLE IF NOT EXISTS answer (
  app TEXT NOT NULL,
  subject TEXT NOT NULL,
  q1 TEXT NOT NULL,
  q2 TEXT NOT NULL,
  q3 TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (app, subject)
);
CREATE TABLE IF NOT EXISTS export (
  app TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app, id)
);
CREATE INDEX IF NOT EXISTS export_ready ON export (app, status, created_at DESC, id DESC);
