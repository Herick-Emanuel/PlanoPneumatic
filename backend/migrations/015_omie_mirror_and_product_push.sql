-- Omie <-> app em conversa:
-- 1) Espelho local de pedidos e notas fiscais (a tela le daqui; o Omie avisa por webhook e uma
--    sincronizacao incremental cobre o que faltar), sem consultar o ERP a cada abertura de tela.
-- 2) Envio de pecas novas do app para o Omie, com aprovacao.

CREATE TABLE IF NOT EXISTS omie_orders (
  omie_code BIGINT PRIMARY KEY,
  number VARCHAR(40) NOT NULL DEFAULT '',
  order_date DATE,
  customer_code BIGINT,
  invoiced BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  data JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS omie_orders_date_idx ON omie_orders(order_date DESC, omie_code DESC);
CREATE INDEX IF NOT EXISTS omie_orders_synced_idx ON omie_orders(synced_at DESC);

CREATE TABLE IF NOT EXISTS omie_invoices (
  mirror_key VARCHAR(80) PRIMARY KEY,
  ref VARCHAR(20) NOT NULL,
  number VARCHAR(20) NOT NULL DEFAULT '',
  series VARCHAR(10) NOT NULL DEFAULT '',
  issue_date DATE,
  nf_type VARCHAR(10) NOT NULL DEFAULT 'saida',
  customer_code BIGINT,
  total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  data JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS omie_invoices_date_idx ON omie_invoices(issue_date DESC, number DESC);
CREATE INDEX IF NOT EXISTS omie_invoices_ref_idx ON omie_invoices(ref);
CREATE INDEX IF NOT EXISTS omie_invoices_synced_idx ON omie_invoices(synced_at DESC);

-- Avisos recebidos do Omie (webhook): guardados para auditoria e para nao processar o mesmo duas vezes.
CREATE TABLE IF NOT EXISTS omie_webhook_events (
  id SERIAL PRIMARY KEY,
  message_id VARCHAR(120),
  topic VARCHAR(120) NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS omie_webhook_events_message_unique ON omie_webhook_events(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS omie_webhook_events_received_idx ON omie_webhook_events(received_at DESC);

-- Pecas: dados exigidos pelo Omie e situacao do envio.
-- omie_status: NULL (anterior a esta mudanca, nunca enviada) | pending_approval | sending | synced | error
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS unit VARCHAR(10),
  ADD COLUMN IF NOT EXISTS ncm VARCHAR(10),
  ADD COLUMN IF NOT EXISTS reference_price NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS omie_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS omie_error TEXT,
  ADD COLUMN IF NOT EXISTS omie_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS omie_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS omie_approved_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS omie_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS omie_sent_at TIMESTAMPTZ;
-- O que ja veio do Omie esta vinculado.
UPDATE products SET omie_status = 'synced' WHERE omie_code IS NOT NULL AND omie_status IS NULL;
CREATE INDEX IF NOT EXISTS products_omie_retry_idx ON products(omie_next_attempt_at) WHERE omie_status = 'error' AND omie_next_attempt_at IS NOT NULL;
