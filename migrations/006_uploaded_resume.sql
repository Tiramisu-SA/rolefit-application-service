ALTER TABLE applications ADD COLUMN resume_source text NOT NULL DEFAULT 'tailored'
  CHECK (resume_source IN ('tailored','uploaded'));
CREATE TABLE application_resume_files (
 application_id text PRIMARY KEY REFERENCES applications(id),
 file_name text NOT NULL, content_type text NOT NULL,
 size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
 content bytea NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now()
);
