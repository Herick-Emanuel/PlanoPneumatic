-- F3: cadastro de clientes e produtos.
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  document VARCHAR(20),
  email VARCHAR(180),
  phone VARCHAR(40),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_document_unique ON customers(document) WHERE document IS NOT NULL;

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  description VARCHAR(180) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id),
  ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id);
CREATE INDEX IF NOT EXISTS cases_customer_idx ON cases(customer_id);
CREATE INDEX IF NOT EXISTS cases_product_idx ON cases(product_id);

-- F4: anexos reais guardados no PostgreSQL.
ALTER TABLE case_attachments
  ALTER COLUMN file_url DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS content BYTEA,
  ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS size_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'documento',
  ADD COLUMN IF NOT EXISTS stage VARCHAR(60),
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE case_attachments DROP CONSTRAINT IF EXISTS case_attachments_has_payload;
ALTER TABLE case_attachments ADD CONSTRAINT case_attachments_has_payload CHECK (content IS NOT NULL OR file_url IS NOT NULL);
