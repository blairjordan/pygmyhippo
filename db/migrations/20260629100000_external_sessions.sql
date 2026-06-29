-- migrate:up
ALTER TABLE workflow_step_attempts
  ADD COLUMN external_session_id TEXT,
  ADD COLUMN external_session_kind TEXT;

ALTER TABLE workflow_waits
  ADD COLUMN external_session_id TEXT,
  ADD COLUMN external_session_kind TEXT;

CREATE INDEX workflow_waits_external_session_idx
  ON workflow_waits (external_session_id)
  WHERE external_session_id IS NOT NULL;

CREATE INDEX workflow_step_attempts_external_session_idx
  ON workflow_step_attempts (external_session_id)
  WHERE external_session_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS workflow_step_attempts_external_session_idx;
DROP INDEX IF EXISTS workflow_waits_external_session_idx;

ALTER TABLE workflow_waits
  DROP COLUMN IF EXISTS external_session_kind,
  DROP COLUMN IF EXISTS external_session_id;

ALTER TABLE workflow_step_attempts
  DROP COLUMN IF EXISTS external_session_kind,
  DROP COLUMN IF EXISTS external_session_id;
