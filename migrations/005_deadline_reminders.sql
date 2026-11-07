-- FR-17: reminder events are not tied to an application.
ALTER TABLE notification_outbox ALTER COLUMN application_id DROP NOT NULL;
CREATE TABLE deadline_reminders (
 candidate_id text NOT NULL, job_id text NOT NULL,
 sent_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (candidate_id, job_id)
);
