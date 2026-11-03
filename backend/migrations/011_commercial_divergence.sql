-- F6: validacao comercial contra o pedido do Omie. Guarda o numero do pedido e as divergencias encontradas.
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS omie_order_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS commercial_divergence JSONB;
