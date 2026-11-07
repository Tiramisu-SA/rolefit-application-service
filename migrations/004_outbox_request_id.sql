-- The request that caused a status change, so the outbox worker can pass it on as the
-- AMQP correlation id. Kept outside the payload: the event contract forbids extra fields.
ALTER TABLE notification_outbox ADD COLUMN request_id text;
