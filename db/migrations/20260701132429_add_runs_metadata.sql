-- migrate:up
ALTER TABLE workflow_runs ADD COLUMN metadata jsonb DEFAULT '{}'::jsonb NOT NULL;
CREATE INDEX idx_workflow_runs_metadata ON workflow_runs USING GIN (metadata);

-- migrate:down
DROP INDEX idx_workflow_runs_metadata;
ALTER TABLE workflow_runs DROP COLUMN metadata;
