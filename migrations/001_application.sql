CREATE TABLE applications (
 id text PRIMARY KEY, job_id text NOT NULL, company_id text NOT NULL, candidate_id text NOT NULL,
 candidate jsonb NOT NULL, job_snapshot jsonb NOT NULL, resume_reference jsonb, match_snapshot jsonb,
 status text NOT NULL CHECK (status IN ('Submitted','Under review','Interview','Offer','Rejected')),
 submitted_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX applications_candidate_idx ON applications(candidate_id);
CREATE INDEX applications_company_job_idx ON applications(company_id,job_id);
CREATE TABLE application_status_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, application_id text NOT NULL REFERENCES applications(id),
 status text NOT NULL CHECK (status IN ('Submitted','Under review','Interview','Offer','Rejected')),
 at timestamptz NOT NULL, changed_by text NOT NULL, note text
);
CREATE TABLE notification_outbox (
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE, event_id uuid PRIMARY KEY,
 application_id text NOT NULL REFERENCES applications(id), payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE INDEX notification_outbox_pending_idx ON notification_outbox(sequence) WHERE published_at IS NULL;
