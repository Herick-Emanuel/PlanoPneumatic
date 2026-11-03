-- Numeracao de casos por sequencia (prefixo + ano), sem COUNT(*).
CREATE TABLE IF NOT EXISTS case_sequences (
  prefix VARCHAR(8) NOT NULL,
  year INTEGER NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year)
);

INSERT INTO case_sequences (prefix, year, last_value)
SELECT split_part(case_number, '-', 1), split_part(case_number, '-', 2)::int, MAX(split_part(case_number, '-', 3)::int)
FROM cases
WHERE case_number ~ '^(PV|TRO|GAR)-[0-9]{4}-[0-9]+$'
GROUP BY 1, 2
ON CONFLICT (prefix, year) DO NOTHING;

-- Arquivamento logico e bloqueio de exclusao fisica.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE case_events ADD COLUMN IF NOT EXISTS details JSONB;

CREATE OR REPLACE FUNCTION prevent_case_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Exclusao fisica de processos nao e permitida; use o arquivamento.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cases_no_delete ON cases;
CREATE TRIGGER cases_no_delete BEFORE DELETE ON cases FOR EACH ROW EXECUTE FUNCTION prevent_case_delete();

-- Indices.
CREATE INDEX IF NOT EXISTS cases_type_idx ON cases(type);
CREATE INDEX IF NOT EXISTS cases_updated_at_idx ON cases(updated_at DESC);
CREATE INDEX IF NOT EXISTS cases_archived_at_idx ON cases(archived_at);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS case_events_created_at_idx ON case_events(case_id, created_at);

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm indisponivel: buscas seguem funcionando sem indice trigram (%).', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS cases_client_trgm_idx ON cases USING gin (client gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS cases_product_trgm_idx ON cases USING gin (product gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS cases_number_trgm_idx ON cases USING gin (case_number gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS cases_product_code_trgm_idx ON cases USING gin (product_code gin_trgm_ops);
  END IF;
END $$;
