-- Controle de carcacas (base de troca): o cliente recebe uma peca remanufaturada e fica devendo a carcaca
-- (a peca usada). Saldo por cliente e por representante, com prazo de devolucao.
-- Nada do fluxo atual de "Base de troca" (processo de troca/devolucao) e alterado.

CREATE TABLE IF NOT EXISTS representatives (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(40),
  email VARCHAR(180),
  phone VARCHAR(40),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS representatives_code_unique ON representatives(lower(code)) WHERE code IS NOT NULL;

-- Representante padrao do cliente (cada lancamento herda e pode trocar).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS representative_id INTEGER REFERENCES representatives(id) ON DELETE SET NULL;

-- Peca remanufaturada: a venda dela gera debito de carcaca.
ALTER TABLE products ADD COLUMN IF NOT EXISTS remanufactured BOOLEAN NOT NULL DEFAULT FALSE;

-- Livro de lancamentos (nunca se apaga: correcao = estorno).
--  debit      saida de peca remanufaturada: o cliente passa a dever `quantity` carcacas ate `due_date`;
--  return     carcaca devolvida: condition = aproveitavel (abate o saldo) | refugada (registrada, nao abate);
--  adjustment correcao manual com sinal (quantity positiva aumenta o saldo, negativa diminui).
CREATE TABLE IF NOT EXISTS carcass_entries (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(12) NOT NULL CHECK (kind IN ('debit', 'return', 'adjustment')),
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name VARCHAR(180) NOT NULL,
  representative_id INTEGER REFERENCES representatives(id) ON DELETE SET NULL,
  product_code VARCHAR(80) NOT NULL,
  product_description VARCHAR(180),
  quantity INTEGER NOT NULL CHECK (quantity <> 0),
  condition VARCHAR(12) CHECK (condition IS NULL OR condition IN ('aproveitavel', 'refugada')),
  due_date DATE,
  entry_date DATE NOT NULL DEFAULT ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date),
  document VARCHAR(120),
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  source_key VARCHAR(160),
  case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at TIMESTAMPTZ,
  reversed_by INTEGER REFERENCES users(id),
  reversal_reason VARCHAR(240),
  CHECK (kind = 'adjustment' OR quantity > 0),
  CHECK (kind <> 'return' OR condition IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS carcass_entries_source_unique ON carcass_entries(source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS carcass_entries_customer_idx ON carcass_entries(customer_id, product_code) WHERE reversed_at IS NULL;
CREATE INDEX IF NOT EXISTS carcass_entries_representative_idx ON carcass_entries(representative_id) WHERE reversed_at IS NULL;
CREATE INDEX IF NOT EXISTS carcass_entries_date_idx ON carcass_entries(entry_date DESC, id DESC);

-- Notas do Omie so geram debito a partir desta data (evita transformar o historico inteiro em divida).
INSERT INTO app_settings (key, value) VALUES ('carcass_omie_start', to_jsonb(to_char((NOW() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD')))
ON CONFLICT (key) DO NOTHING;
