CREATE TABLE IF NOT EXISTS wordless_gateway_inbox (
  installation_id text NOT NULL,
  delivery_key text NOT NULL,
  body_sha256 char(64) NOT NULL,
  payload_json jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'retry', 'leased', 'completed', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text,
  PRIMARY KEY (installation_id, delivery_key)
);

CREATE TABLE IF NOT EXISTS wordless_gateway_choice_state (
  installation_id text NOT NULL,
  app_id text NOT NULL,
  conversation_id text NOT NULL,
  user_id text NOT NULL,
  payload text NOT NULL,
  suggestion_id text NOT NULL,
  source_message_id text NOT NULL,
  source_message_nonce text NOT NULL,
  issued_at timestamptz NOT NULL,
  choice_id text NOT NULL,
  detector_id text,
  reply text NOT NULL,
  feedback text NOT NULL CHECK (feedback IN ('confirmed', 'none', 'skip')),
  consumed_by_event_id text,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (installation_id, payload)
);

CREATE TABLE IF NOT EXISTS wordless_gateway_event_claims (
  installation_id text NOT NULL,
  event_id text NOT NULL,
  owner_delivery_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('leased', 'retry', 'completed')),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (installation_id, event_id)
);

CREATE TABLE IF NOT EXISTS wordless_gateway_conversation_state (
  installation_id text NOT NULL,
  conversation_id text NOT NULL,
  latest_customer_event_id text NOT NULL,
  latest_customer_event_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS wordless_gateway_choice_lookup
  ON wordless_gateway_choice_state (installation_id, app_id, conversation_id, user_id, expires_at);

CREATE TABLE IF NOT EXISTS wordless_gateway_outbox (
  id uuid PRIMARY KEY,
  sequence_no bigserial NOT NULL UNIQUE,
  installation_id text NOT NULL,
  event_key text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('post_message', 'pass_control', 'release_control')),
  product_mode text NOT NULL CHECK (product_mode = 'customer_clarify'),
  conversation_id text NOT NULL,
  guard_event_id text,
  request_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retry', 'leased', 'sent', 'dead', 'ambiguous')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error_code text,
  UNIQUE (installation_id, event_key)
);

CREATE INDEX IF NOT EXISTS wordless_gateway_outbox_due
  ON wordless_gateway_outbox (next_attempt_at, sequence_no)
  WHERE status IN ('pending', 'retry', 'leased');

CREATE TABLE IF NOT EXISTS wordless_gateway_conversation_quarantine (
  installation_id text NOT NULL,
  conversation_id text NOT NULL,
  outbox_id uuid NOT NULL,
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, conversation_id, outbox_id)
);

CREATE OR REPLACE FUNCTION wordless_gateway_purge_installation(p_installation_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM wordless_gateway_choice_state WHERE installation_id = p_installation_id;
  DELETE FROM wordless_gateway_event_claims WHERE installation_id = p_installation_id;
  DELETE FROM wordless_gateway_conversation_state WHERE installation_id = p_installation_id;
  DELETE FROM wordless_gateway_conversation_quarantine WHERE installation_id = p_installation_id;
  DELETE FROM wordless_gateway_outbox WHERE installation_id = p_installation_id;
  DELETE FROM wordless_gateway_inbox WHERE installation_id = p_installation_id;
END;
$$;
