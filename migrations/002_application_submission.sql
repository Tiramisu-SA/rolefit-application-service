-- Keep legacy fixtures intact; do not fabricate missing snapshots.
ALTER TABLE applications ADD COLUMN resume_snapshot jsonb;
ALTER TABLE applications ADD COLUMN cover_letter text;
-- Fail migration visibly if old data contains duplicate candidate/job pairs.
-- Resolve such records explicitly before retrying; never delete them automatically.
CREATE UNIQUE INDEX applications_candidate_job_unique ON applications(candidate_id,job_id);
