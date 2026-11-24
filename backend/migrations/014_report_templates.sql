-- Construtor de relatorios: modelos salvos por administradores e gerentes (fonte, colunas, filtros, agrupamento).
CREATE TABLE IF NOT EXISTS report_templates (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(240) NOT NULL DEFAULT '',
  shared BOOLEAN NOT NULL DEFAULT FALSE,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS report_templates_owner_idx ON report_templates(owner_id);
CREATE INDEX IF NOT EXISTS report_templates_shared_idx ON report_templates(shared) WHERE shared = TRUE;
