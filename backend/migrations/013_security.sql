-- Secao 2 do escopo (seguranca): troca obrigatoria de senha, sessoes rastreaveis, bloqueio de login
-- por e-mail, auditoria geral com IP e MFA (TOTP).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_secret TEXT,
  ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT,
  ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS ip VARCHAR(64),
  ADD COLUMN IF NOT EXISTS user_agent VARCHAR(300);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

-- Tentativas de login com bloqueio progressivo (chave e-mail+IP e chave so e-mail). Guarda so hashes.
CREATE TABLE IF NOT EXISTS login_throttle (
  throttle_key CHAR(64) PRIMARY KEY,
  email_hash CHAR(64) NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_failed_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS login_throttle_email_idx ON login_throttle(email_hash);

-- Aparelhos onde o usuario ja entrou com sucesso: nao sofrem o bloqueio "so por e-mail" (anti-DoS da conta).
CREATE TABLE IF NOT EXISTS trusted_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS trusted_devices_user_idx ON trusted_devices(user_id);

-- Auditoria geral: login, falhas, troca de senha, sessoes, MFA, usuarios e processos.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(30),
  entity_id VARCHAR(80),
  ip VARCHAR(64),
  user_agent VARCHAR(300),
  request_id VARCHAR(64),
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action, created_at DESC);

-- Segundo passo do login quando o usuario tem MFA: desafio curto e de uso unico.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx ON mfa_recovery_codes(user_id);

-- Configuracoes de seguranca (somente administrador altera).
INSERT INTO app_settings (key, value) VALUES
  ('manager_team_scope', 'false'::jsonb),
  ('mfa_required', 'false'::jsonb),
  ('activity_tracking', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- A sessao saiu do localStorage (token Bearer) para cookie HttpOnly: encerra as sessoes antigas para que
-- tokens que ficaram guardados no navegador deixem de valer. Todos entram de novo uma vez.
DELETE FROM sessions;
