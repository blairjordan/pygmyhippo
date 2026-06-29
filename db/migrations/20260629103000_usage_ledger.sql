-- migrate:up
ALTER TYPE workflow_run_status ADD VALUE IF NOT EXISTS 'exhausted_budget';

CREATE TABLE workflow_run_usage (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  step_attempt_id UUID,
  resource TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  cost_usd NUMERIC CHECK (cost_usd IS NULL OR cost_usd >= 0),
  dimension TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id, step_attempt_id)
    REFERENCES workflow_step_attempts (run_id, id)
    ON DELETE SET NULL
) PARTITION BY HASH (run_id);

CREATE INDEX workflow_run_usage_run_id_recorded_at_idx
  ON workflow_run_usage (run_id, recorded_at, id);

CREATE INDEX workflow_run_usage_run_id_resource_idx
  ON workflow_run_usage (run_id, resource);

DO $$
BEGIN
  FOR partition_index IN 0..15 LOOP
    EXECUTE format(
      'CREATE TABLE workflow_run_usage_p%s PARTITION OF workflow_run_usage FOR VALUES WITH (modulus 16, remainder %s)',
      lpad(partition_index::text, 2, '0'),
      partition_index
    );
  END LOOP;
END
$$;

COMMENT ON TABLE workflow_run_usage IS 'Metered resource usage recorded by workflow runs';

-- migrate:down
DROP TABLE IF EXISTS workflow_run_usage;
