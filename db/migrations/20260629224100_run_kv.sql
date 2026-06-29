-- migrate:up
CREATE TABLE workflow_run_kv (
  run_id UUID NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, key)
);

CREATE INDEX workflow_run_kv_run_id_idx ON workflow_run_kv (run_id);

COMMENT ON TABLE workflow_run_kv IS 'Run-scoped key-value side channel store';

-- migrate:down
DROP TABLE IF EXISTS workflow_run_kv;
