-- migrate:up
ALTER TABLE workflow_runs
  ADD COLUMN idempotency_key TEXT;

ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_definition_name_idempotency_key_key
  UNIQUE (definition_name, idempotency_key);

CREATE INDEX workflow_runs_definition_name_idempotency_key_idx
  ON workflow_runs (definition_name, idempotency_key);

-- migrate:down
DROP INDEX IF EXISTS workflow_runs_definition_name_idempotency_key_idx;

ALTER TABLE workflow_runs
  DROP CONSTRAINT IF EXISTS workflow_runs_definition_name_idempotency_key_key;

ALTER TABLE workflow_runs
  DROP COLUMN IF EXISTS idempotency_key;
