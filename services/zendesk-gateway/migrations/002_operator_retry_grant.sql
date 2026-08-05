ALTER TABLE wordless_gateway_outbox
  ADD COLUMN IF NOT EXISTS operator_retry_remaining smallint NOT NULL DEFAULT 0
  CHECK (operator_retry_remaining IN (0, 1));
