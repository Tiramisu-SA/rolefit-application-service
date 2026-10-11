ALTER TABLE applications ADD COLUMN development jsonb;
ALTER TABLE applications ADD CONSTRAINT applications_development_object
  CHECK (development IS NULL OR jsonb_typeof(development) = 'object');
