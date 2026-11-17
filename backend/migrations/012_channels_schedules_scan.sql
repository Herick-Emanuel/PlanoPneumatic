-- F9: canais de aviso por usuario (e-mail e WhatsApp) e registro de cada envio.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notify_whatsapp BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id SERIAL PRIMARY KEY,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notification_deliveries_user_idx ON notification_deliveries(user_id, created_at DESC);

-- F13: o mesmo token de uso unico serve para redefinir senha e para aceitar convite.
ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) NOT NULL DEFAULT 'reset';

-- F11: relatorios enviados por e-mail em dia e hora fixos.
CREATE TABLE IF NOT EXISTS report_schedules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  format VARCHAR(10) NOT NULL CHECK (format IN ('xlsx', 'pdf', 'csv')),
  frequency VARCHAR(10) NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  weekday SMALLINT CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  hour SMALLINT NOT NULL DEFAULT 7 CHECK (hour BETWEEN 0 AND 23),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS report_schedules_user_idx ON report_schedules(user_id);

-- F4: resultado da verificacao antivirus de cada anexo.
ALTER TABLE case_attachments ADD COLUMN IF NOT EXISTS scan_status VARCHAR(20);
