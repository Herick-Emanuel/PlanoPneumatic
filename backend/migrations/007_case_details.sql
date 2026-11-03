-- F1: campos especificos de cada tipo de processo.
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS sales_representative VARCHAR(120),
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12, 2) CHECK (unit_price IS NULL OR unit_price >= 0),
  ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(120),
  ADD COLUMN IF NOT EXISTS sales_channel VARCHAR(80),
  ADD COLUMN IF NOT EXISTS exchange_reason VARCHAR(80),
  ADD COLUMN IF NOT EXISTS item_condition VARCHAR(80),
  ADD COLUMN IF NOT EXISTS origin_order VARCHAR(80),
  ADD COLUMN IF NOT EXISTS tracking_code VARCHAR(80),
  ADD COLUMN IF NOT EXISTS received_at DATE,
  ADD COLUMN IF NOT EXISTS defect_description TEXT,
  ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20),
  ADD COLUMN IF NOT EXISTS serial_number VARCHAR(80),
  ADD COLUMN IF NOT EXISTS lot_number VARCHAR(80),
  ADD COLUMN IF NOT EXISTS logistics_status VARCHAR(40);

-- F2/F5: motivo de encerramento, laudo tecnico e decisao.
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS status_reason TEXT,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS technical_report TEXT,
  ADD COLUMN IF NOT EXISTS warranty_decision VARCHAR(20) CHECK (warranty_decision IS NULL OR warranty_decision IN ('procedente', 'improcedente')),
  ADD COLUMN IF NOT EXISTS warranty_destination VARCHAR(20) CHECK (warranty_destination IS NULL OR warranty_destination IN ('reposicao', 'devolucao', 'troca', 'arquivo')),
  ADD COLUMN IF NOT EXISTS technical_owner_id INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS decided_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopen_count INTEGER NOT NULL DEFAULT 0;

-- F8: SLA aplicado de verdade.
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_notified_at TIMESTAMPTZ;

INSERT INTO case_sla_config (type, days) VALUES ('Pedido de venda', 3), ('Base de troca', 5), ('Garantia', 7) ON CONFLICT (type) DO NOTHING;

UPDATE cases c
SET due_at = c.created_at + (SELECT days FROM case_sla_config WHERE type = c.type) * INTERVAL '1 day'
WHERE due_at IS NULL;

-- F6: itens do pedido.
CREATE TABLE IF NOT EXISTS case_items (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  product_code VARCHAR(80) NOT NULL,
  description VARCHAR(180) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) CHECK (unit_price IS NULL OR unit_price >= 0),
  serial_number VARCHAR(80),
  lot_number VARCHAR(80)
);
CREATE INDEX IF NOT EXISTS case_items_case_id_idx ON case_items(case_id);
CREATE INDEX IF NOT EXISTS case_items_serial_idx ON case_items(serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS cases_serial_idx ON cases(serial_number) WHERE serial_number IS NOT NULL;

-- Bloqueio de duplicidade por documento de origem (F3).
-- Se a base ja tiver documentos de origem repetidos, o indice nao e criado (a migration nao pode derrubar o deploy);
-- a validacao da aplicacao continua bloqueando novas duplicidades.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS cases_origin_document_unique
    ON cases (type, lower(document_reference))
    WHERE document_reference IS NOT NULL AND archived_at IS NULL AND status NOT IN ('Cancelado', 'Improcedente');
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'Indice cases_origin_document_unique nao criado: ha documentos de origem duplicados. Revise e crie manualmente.';
END $$;

-- Configuracoes persistidas.
CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(60) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO app_settings (key, value) VALUES
  ('alerts_enabled', 'true'::jsonb),
  ('auto_refresh', 'true'::jsonb),
  ('require_documents', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
