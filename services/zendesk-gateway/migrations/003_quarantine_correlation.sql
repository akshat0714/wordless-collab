ALTER TABLE wordless_gateway_conversation_quarantine
  ADD COLUMN IF NOT EXISTS operation_kind text
    CHECK (operation_kind IN ('post_message', 'pass_control', 'release_control')),
  ADD COLUMN IF NOT EXISTS event_key text,
  ADD COLUMN IF NOT EXISTS guard_event_id text,
  ADD COLUMN IF NOT EXISTS zendesk_delivery_key text,
  ADD COLUMN IF NOT EXISTS zendesk_first_message_id text,
  ADD COLUMN IF NOT EXISTS handoff_reason text,
  ADD COLUMN IF NOT EXISTS zendesk_release_key text;

UPDATE wordless_gateway_conversation_quarantine AS quarantine
   SET operation_kind = outbox.operation_kind,
       event_key = outbox.event_key,
       guard_event_id = outbox.guard_event_id,
       zendesk_delivery_key = outbox.request_json #>> '{body,metadata,wordless_delivery_key}',
       zendesk_first_message_id = outbox.request_json #>> '{body,metadata,first_message_id}',
       handoff_reason = outbox.request_json #>> '{body,metadata,handoff_reason}',
       zendesk_release_key = outbox.request_json #>> '{body,metadata,wordless_release_key}'
  FROM wordless_gateway_outbox AS outbox
 WHERE outbox.id = quarantine.outbox_id
   AND quarantine.operation_kind IS NULL;
