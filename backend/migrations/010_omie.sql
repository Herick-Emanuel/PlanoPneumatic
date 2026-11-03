-- Integracao com o Omie (ERP): vinculo dos cadastros e historico das sincronizacoes.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS omie_code BIGINT,
  ADD COLUMN IF NOT EXISTS omie_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS customers_omie_code_unique ON customers(omie_code) WHERE omie_code IS NOT NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS omie_code BIGINT,
  ADD COLUMN IF NOT EXISTS omie_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS products_omie_code_unique ON products(omie_code) WHERE omie_code IS NOT NULL;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS omie_order_code BIGINT,
  ADD COLUMN IF NOT EXISTS omie_invoice_number VARCHAR(20);

CREATE TABLE IF NOT EXISTS omie_sync_runs (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,
  trigger VARCHAR(20) NOT NULL DEFAULT 'manual',
  started_by INTEGER REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  message TEXT
);
CREATE INDEX IF NOT EXISTS omie_sync_runs_kind_idx ON omie_sync_runs(kind, started_at DESC);
