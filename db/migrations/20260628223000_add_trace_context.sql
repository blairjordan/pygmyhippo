-- migrate:up
ALTER TABLE workflow_runs ADD COLUMN trace_context TEXT;
ALTER TABLE workflow_step_attempts ADD COLUMN trace_context TEXT;

-- migrate:down
ALTER TABLE workflow_step_attempts DROP COLUMN trace_context;
ALTER TABLE workflow_runs DROP COLUMN trace_context;
