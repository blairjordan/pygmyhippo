/* @name InsertRun */
INSERT INTO workflow_runs (
  definition_name,
  definition_version,
  status,
  current_step_key,
  input,
  context
) VALUES (
  :definitionName,
  :definitionVersion,
  'queued',
  :currentStepKey,
  :input,
  '{}'::jsonb
)
RETURNING
  id,
  definition_name AS "definitionName",
  definition_version AS "definitionVersion",
  status,
  current_step_key AS "currentStepKey",
  input,
  context,
  result,
  error,
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt";

/* @name GetRunById */
SELECT
  id,
  definition_name AS "definitionName",
  definition_version AS "definitionVersion",
  status,
  current_step_key AS "currentStepKey",
  input,
  context,
  result,
  error,
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"
FROM workflow_runs
WHERE id = :runId;

/* @name GetRunEvents */
SELECT
  id,
  run_id AS "runId",
  step_key AS "stepKey",
  event_type AS "eventType",
  payload,
  created_at AS "createdAt"
FROM workflow_events
WHERE run_id = :runId
ORDER BY created_at ASC, id ASC;

/* @name ClaimNextRunnableRun */
WITH candidate AS (
  SELECT id
  FROM workflow_runs
  WHERE status IN ('queued', 'running')
    AND current_step_key IS NOT NULL
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE workflow_runs AS runs
SET
  status = 'running',
  lease_owner = :workerId,
  lease_expires_at = now() + (:leaseMs * interval '1 millisecond'),
  updated_at = now()
FROM candidate
WHERE runs.id = candidate.id
RETURNING
  runs.id,
  runs.definition_name AS "definitionName",
  runs.definition_version AS "definitionVersion",
  runs.status,
  runs.current_step_key AS "currentStepKey",
  runs.input,
  runs.context,
  runs.result,
  runs.error,
  runs.lease_owner AS "leaseOwner",
  runs.lease_expires_at AS "leaseExpiresAt",
  runs.created_at AS "createdAt",
  runs.updated_at AS "updatedAt",
  runs.completed_at AS "completedAt";

/* @name GetLastStepAttempt */
SELECT COALESCE(MAX(attempt), 0)::int AS "lastAttempt"
FROM workflow_step_attempts
WHERE run_id = :runId
  AND step_key = :stepKey;

/* @name InsertStepAttempt */
INSERT INTO workflow_step_attempts (
  run_id,
  step_key,
  attempt,
  status,
  input
) VALUES (
  :runId,
  :stepKey,
  :attempt,
  'started',
  :input
)
RETURNING
  id,
  run_id AS "runId",
  step_key AS "stepKey",
  attempt,
  status,
  input,
  output,
  error,
  started_at AS "startedAt",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt";

/* @name CompleteStepAttempt */
UPDATE workflow_step_attempts
SET
  status = :status,
  output = :output,
  error = :error,
  completed_at = now(),
  updated_at = now()
WHERE id = :attemptId
RETURNING
  id,
  run_id AS "runId",
  step_key AS "stepKey",
  attempt,
  status,
  input,
  output,
  error,
  started_at AS "startedAt",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt";

/* @name UpdateRunForNextStep */
UPDATE workflow_runs
SET
  status = 'queued',
  current_step_key = :nextStepKey,
  context = :context,
  result = NULL,
  error = NULL,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = now()
WHERE id = :runId
RETURNING
  id,
  definition_name AS "definitionName",
  definition_version AS "definitionVersion",
  status,
  current_step_key AS "currentStepKey",
  input,
  context,
  result,
  error,
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt";

/* @name MarkRunWaiting */
UPDATE workflow_runs
SET
  status = 'waiting',
  current_step_key = :stepKey,
  context = :context,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = now()
WHERE id = :runId
RETURNING
  id,
  definition_name AS "definitionName",
  definition_version AS "definitionVersion",
  status,
  current_step_key AS "currentStepKey",
  input,
  context,
  result,
  error,
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt";

/* @name MarkRunCompleted */
UPDATE workflow_runs
SET
  status = 'completed',
  current_step_key = NULL,
  context = :context,
  result = :result,
  error = NULL,
  lease_owner = NULL,
  lease_expires_at = NULL,
  updated_at = now(),
  completed_at = now()
WHERE id = :runId
RETURNING
  id,
  definition_name AS "definitionName",
  definition_version AS "definitionVersion",
  status,
  current_step_key AS "currentStepKey",
  input,
  context,
  result,
  error,
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt";

/* @name MarkRunFailed */
UPDATE workflow_runs
SET
  status = 'failed',
  lease_owner = NULL,
  lease_expires_at = NULL,
  error = :error,
  updated_at = now(),
  completed_at = now()
WHERE id = :runId
RETURNING
  id,
  definition_name AS "definitionName",
  definition_version AS "definitionVersion",
  status,
  current_step_key AS "currentStepKey",
  input,
  context,
  result,
  error,
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt";

/* @name InsertWait */
INSERT INTO workflow_waits (
  run_id,
  step_key,
  correlation_key,
  status,
  payload
) VALUES (
  :runId,
  :stepKey,
  :correlationKey,
  'open',
  :payload
)
RETURNING
  id,
  run_id AS "runId",
  step_key AS "stepKey",
  correlation_key AS "correlationKey",
  status,
  payload,
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  resumed_at AS "resumedAt";

/* @name GetOpenWaitByCorrelationKey */
SELECT
  id,
  run_id AS "runId",
  step_key AS "stepKey",
  correlation_key AS "correlationKey",
  status,
  payload,
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  resumed_at AS "resumedAt"
FROM workflow_waits
WHERE correlation_key = :correlationKey
  AND status = 'open';

/* @name MarkWaitResumed */
UPDATE workflow_waits
SET
  status = 'resumed',
  resumed_at = now(),
  updated_at = now()
WHERE id = :waitId
RETURNING
  id,
  run_id AS "runId",
  step_key AS "stepKey",
  correlation_key AS "correlationKey",
  status,
  payload,
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  resumed_at AS "resumedAt";

/* @name InsertEvent */
INSERT INTO workflow_events (
  run_id,
  step_key,
  event_type,
  payload
) VALUES (
  :runId,
  :stepKey,
  :eventType,
  :payload
)
RETURNING
  id,
  run_id AS "runId",
  step_key AS "stepKey",
  event_type AS "eventType",
  payload,
  created_at AS "createdAt";

/* @name CountOpenWaits */
SELECT COUNT(*)::int AS "waitCount"
FROM workflow_waits
WHERE status = 'open';
