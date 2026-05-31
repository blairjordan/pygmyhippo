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
  available_at AS "availableAt",
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
  available_at AS "availableAt",
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

/* @name ClaimNextRunnableRun */
WITH candidate AS (
  SELECT id
  FROM workflow_runs
  WHERE status IN ('queued', 'running')
    AND current_step_key IS NOT NULL
    AND available_at <= now()
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
  ORDER BY available_at ASC, created_at ASC
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
  runs.available_at AS "availableAt",
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

/* @name CompleteRun */
WITH updated_run AS (
  UPDATE workflow_runs
  SET
    status = 'completed',
    current_step_key = NULL,
    context = :context,
    result = :result,
    error = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    available_at = now(),
    updated_at = now(),
    completed_at = now()
  WHERE id = :runId
    AND current_step_key = :stepKey
    AND lease_owner = :workerId
    AND lease_expires_at >= now()
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
    available_at AS "availableAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
), inserted_event AS (
  INSERT INTO workflow_events (run_id, step_key, event_type, payload)
  SELECT id, :stepKey, :eventType, :eventPayload
  FROM updated_run
)
SELECT * FROM updated_run;

/* @name AdvanceTaskStep */
WITH updated_run AS (
  UPDATE workflow_runs
  SET
    status = 'queued',
    current_step_key = :nextStepKey,
    context = :context,
    result = NULL,
    error = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    available_at = now(),
    updated_at = now()
  WHERE id = :runId
    AND current_step_key = :stepKey
    AND lease_owner = :workerId
    AND lease_expires_at >= now()
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
    available_at AS "availableAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
), updated_attempt AS (
  UPDATE workflow_step_attempts
  SET
    status = 'completed',
    output = :output,
    error = NULL,
    completed_at = now(),
    updated_at = now()
  WHERE id = :attemptId
    AND run_id IN (SELECT id FROM updated_run)
  RETURNING id
), inserted_event AS (
  INSERT INTO workflow_events (run_id, step_key, event_type, payload)
  SELECT id, :stepKey, :eventType, :eventPayload
  FROM updated_run
)
SELECT * FROM updated_run;

/* @name OpenWait */
WITH updated_run AS (
  UPDATE workflow_runs
  SET
    status = 'waiting',
    current_step_key = :stepKey,
    context = :context,
    result = NULL,
    error = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    available_at = now(),
    updated_at = now()
  WHERE id = :runId
    AND current_step_key = :stepKey
    AND lease_owner = :workerId
    AND lease_expires_at >= now()
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
    available_at AS "availableAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
), inserted_wait AS (
  INSERT INTO workflow_waits (
    run_id,
    step_key,
    correlation_key,
    status,
    payload
  )
  SELECT id, :stepKey, :correlationKey, 'open', :payload
  FROM updated_run
), updated_attempt AS (
  UPDATE workflow_step_attempts
  SET
    status = 'completed',
    output = :output,
    error = NULL,
    completed_at = now(),
    updated_at = now()
  WHERE id = :attemptId
    AND run_id IN (SELECT id FROM updated_run)
  RETURNING id
), inserted_event AS (
  INSERT INTO workflow_events (run_id, step_key, event_type, payload)
  SELECT id, :stepKey, :eventType, :eventPayload
  FROM updated_run
)
SELECT * FROM updated_run;

/* @name ScheduleRetry */
WITH updated_run AS (
  UPDATE workflow_runs
  SET
    status = 'queued',
    current_step_key = :stepKey,
    error = :error,
    lease_owner = NULL,
    lease_expires_at = NULL,
    available_at = :availableAt,
    updated_at = now(),
    completed_at = NULL
  WHERE id = :runId
    AND current_step_key = :stepKey
    AND lease_owner = :workerId
    AND lease_expires_at >= now()
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
    available_at AS "availableAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
), updated_attempt AS (
  UPDATE workflow_step_attempts
  SET
    status = 'failed',
    output = NULL,
    error = :error,
    completed_at = now(),
    updated_at = now()
  WHERE id = :attemptId
    AND run_id IN (SELECT id FROM updated_run)
  RETURNING id
), inserted_event AS (
  INSERT INTO workflow_events (run_id, step_key, event_type, payload)
  SELECT id, :stepKey, :eventType, :eventPayload
  FROM updated_run
)
SELECT * FROM updated_run;

/* @name FailRun */
WITH updated_run AS (
  UPDATE workflow_runs
  SET
    status = 'failed',
    error = :error,
    lease_owner = NULL,
    lease_expires_at = NULL,
    available_at = now(),
    updated_at = now(),
    completed_at = now()
  WHERE id = :runId
    AND current_step_key = :stepKey
    AND lease_owner = :workerId
    AND lease_expires_at >= now()
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
    available_at AS "availableAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
), updated_attempt AS (
  UPDATE workflow_step_attempts
  SET
    status = 'failed',
    output = NULL,
    error = :error,
    completed_at = now(),
    updated_at = now()
  WHERE id = :attemptId
    AND run_id IN (SELECT id FROM updated_run)
  RETURNING id
), inserted_event AS (
  INSERT INTO workflow_events (run_id, step_key, event_type, payload)
  SELECT id, :stepKey, :eventType, :eventPayload
  FROM updated_run
)
SELECT * FROM updated_run;

/* @name ScheduleSleep */
WITH updated_run AS (
  UPDATE workflow_runs
  SET
    status = 'queued',
    current_step_key = :nextStepKey,
    lease_owner = NULL,
    lease_expires_at = NULL,
    available_at = :availableAt,
    updated_at = now()
  WHERE id = :runId
    AND current_step_key = :stepKey
    AND lease_owner = :workerId
    AND lease_expires_at >= now()
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
    available_at AS "availableAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
), inserted_event AS (
  INSERT INTO workflow_events (run_id, step_key, event_type, payload)
  SELECT id, :stepKey, :eventType, :eventPayload
  FROM updated_run
)
SELECT * FROM updated_run;

/* @name GetOpenWaitForUpdate */
SELECT
  id,
  run_id AS "runId",
  step_key AS "stepKey",
  correlation_key AS "correlationKey",
  status,
  payload,
  resume_payload AS "resumePayload",
  resume_output AS "resumeOutput",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  resumed_at AS "resumedAt"
FROM workflow_waits
WHERE correlation_key = :correlationKey
FOR UPDATE;

/* @name GetRunByIdForUpdate */
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
  available_at AS "availableAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"
FROM workflow_runs
WHERE id = :runId
FOR UPDATE;

/* @name CompleteWaitResume */
WITH updated_wait AS (
  UPDATE workflow_waits
  SET
    status = 'resumed',
    resume_payload = :resumePayload,
    resume_output = :output,
    resumed_at = now(),
    updated_at = now()
  WHERE id = :waitId
    AND status = 'open'
  RETURNING id
), updated_run AS (
  UPDATE workflow_runs
  SET
    status = 'queued',
    current_step_key = :nextStepKey,
    context = :context,
    error = NULL,
    available_at = now(),
    updated_at = now()
  WHERE id = :runId
    AND status = 'waiting'
    AND current_step_key = :stepKey
    AND EXISTS (SELECT 1 FROM updated_wait)
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
    available_at AS "availableAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
), inserted_event AS (
  INSERT INTO workflow_events (run_id, step_key, event_type, payload)
  SELECT id, :stepKey, :eventType, :eventPayload
  FROM updated_run
)
SELECT * FROM updated_run;

/* @name CountOpenWaits */
SELECT COUNT(*)::int AS "waitCount"
FROM workflow_waits
WHERE status = 'open';

/* @name Ping */
SELECT 1::int AS ok;
