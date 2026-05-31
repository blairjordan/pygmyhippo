import { sql } from "@pgtyped/runtime"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface IRunRow {
  id: string
  definitionName: string
  definitionVersion: number
  status: string
  currentStepKey: string | null
  input: Json
  context: Json
  result: Json | null
  error: Json | null
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

export interface IAttemptRow {
  id: string
  runId: string
  stepKey: string
  attempt: number
  status: string
  input: Json
  output: Json | null
  error: Json | null
  startedAt: Date
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface IWaitRow {
  id: string
  runId: string
  stepKey: string
  correlationKey: string
  status: "open" | "resumed" | "expired" | "canceled"
  payload: Json | null
  createdAt: Date
  updatedAt: Date
  resumedAt: Date | null
}

export interface IEventRow {
  id: number
  runId: string
  stepKey: string | null
  eventType: string
  payload: Json
  createdAt: Date
}

export interface IInsertRunQuery {
  params: {
    definitionName: string
    definitionVersion: number
    currentStepKey: string
    input: Json
  }
  result: IRunRow
}

export const insertRunQuery = sql<IInsertRunQuery>`
  INSERT INTO workflow_runs (
    definition_name,
    definition_version,
    status,
    current_step_key,
    input,
    context
  ) VALUES (
    $definitionName,
    $definitionVersion,
    'queued',
    $currentStepKey,
    $input,
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
    completed_at AS "completedAt"
`

export interface IGetRunByIdQuery {
  params: { runId: string }
  result: IRunRow
}

export const getRunByIdQuery = sql<IGetRunByIdQuery>`
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
  WHERE id = $runId
`

export interface IGetRunEventsQuery {
  params: { runId: string }
  result: IEventRow
}

export const getRunEventsQuery = sql<IGetRunEventsQuery>`
  SELECT
    id,
    run_id AS "runId",
    step_key AS "stepKey",
    event_type AS "eventType",
    payload,
    created_at AS "createdAt"
  FROM workflow_events
  WHERE run_id = $runId
  ORDER BY created_at ASC, id ASC
`

export interface IClaimNextRunnableRunQuery {
  params: { workerId: string; leaseMs: number }
  result: IRunRow
}

export const claimNextRunnableRunQuery = sql<IClaimNextRunnableRunQuery>`
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
    lease_owner = $workerId,
    lease_expires_at = now() + ($leaseMs * interval '1 millisecond'),
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
    runs.completed_at AS "completedAt"
`

export interface IGetLastStepAttemptQuery {
  params: { runId: string; stepKey: string }
  result: { lastAttempt: number }
}

export const getLastStepAttemptQuery = sql<IGetLastStepAttemptQuery>`
  SELECT COALESCE(MAX(attempt), 0)::int AS "lastAttempt"
  FROM workflow_step_attempts
  WHERE run_id = $runId
    AND step_key = $stepKey
`

export interface IInsertStepAttemptQuery {
  params: { runId: string; stepKey: string; attempt: number; input: Json }
  result: IAttemptRow
}

export const insertStepAttemptQuery = sql<IInsertStepAttemptQuery>`
  INSERT INTO workflow_step_attempts (
    run_id,
    step_key,
    attempt,
    status,
    input
  ) VALUES (
    $runId,
    $stepKey,
    $attempt,
    'started',
    $input
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
    updated_at AS "updatedAt"
`

export interface ICompleteStepAttemptQuery {
  params: {
    attemptId: string
    status: string
    output: Json | null
    error: Json | null
  }
  result: IAttemptRow
}

export const completeStepAttemptQuery = sql<ICompleteStepAttemptQuery>`
  UPDATE workflow_step_attempts
  SET
    status = $status,
    output = $output,
    error = $error,
    completed_at = now(),
    updated_at = now()
  WHERE id = $attemptId
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
    updated_at AS "updatedAt"
`

export interface IUpdateRunForNextStepQuery {
  params: { runId: string; context: Json; nextStepKey: string }
  result: IRunRow
}

export const updateRunForNextStepQuery = sql<IUpdateRunForNextStepQuery>`
  UPDATE workflow_runs
  SET
    status = 'queued',
    current_step_key = $nextStepKey,
    context = $context,
    result = NULL,
    error = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()
  WHERE id = $runId
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
    completed_at AS "completedAt"
`

export interface IMarkRunWaitingQuery {
  params: { runId: string; context: Json; stepKey: string }
  result: IRunRow
}

export const markRunWaitingQuery = sql<IMarkRunWaitingQuery>`
  UPDATE workflow_runs
  SET
    status = 'waiting',
    current_step_key = $stepKey,
    context = $context,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()
  WHERE id = $runId
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
    completed_at AS "completedAt"
`

export interface IMarkRunCompletedQuery {
  params: { runId: string; context: Json; result: Json | null }
  result: IRunRow
}

export const markRunCompletedQuery = sql<IMarkRunCompletedQuery>`
  UPDATE workflow_runs
  SET
    status = 'completed',
    current_step_key = NULL,
    context = $context,
    result = $result,
    error = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now(),
    completed_at = now()
  WHERE id = $runId
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
    completed_at AS "completedAt"
`

export interface IMarkRunFailedQuery {
  params: { runId: string; error: Json }
  result: IRunRow
}

export const markRunFailedQuery = sql<IMarkRunFailedQuery>`
  UPDATE workflow_runs
  SET
    status = 'failed',
    lease_owner = NULL,
    lease_expires_at = NULL,
    error = $error,
    updated_at = now(),
    completed_at = now()
  WHERE id = $runId
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
    completed_at AS "completedAt"
`

export interface IInsertWaitQuery {
  params: {
    runId: string
    stepKey: string
    correlationKey: string
    payload: Json | null
  }
  result: IWaitRow
}

export const insertWaitQuery = sql<IInsertWaitQuery>`
  INSERT INTO workflow_waits (
    run_id,
    step_key,
    correlation_key,
    status,
    payload
  ) VALUES (
    $runId,
    $stepKey,
    $correlationKey,
    'open',
    $payload
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
    resumed_at AS "resumedAt"
`

export interface IGetOpenWaitByCorrelationKeyQuery {
  params: { correlationKey: string }
  result: IWaitRow
}

export const getOpenWaitByCorrelationKeyQuery = sql<IGetOpenWaitByCorrelationKeyQuery>`
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
  WHERE correlation_key = $correlationKey
    AND status = 'open'
`

export interface IMarkWaitResumedQuery {
  params: { waitId: string }
  result: IWaitRow
}

export const markWaitResumedQuery = sql<IMarkWaitResumedQuery>`
  UPDATE workflow_waits
  SET
    status = 'resumed',
    resumed_at = now(),
    updated_at = now()
  WHERE id = $waitId
  RETURNING
    id,
    run_id AS "runId",
    step_key AS "stepKey",
    correlation_key AS "correlationKey",
    status,
    payload,
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    resumed_at AS "resumedAt"
`

export interface IInsertEventQuery {
  params: {
    runId: string
    stepKey: string | null
    eventType: string
    payload: Json
  }
  result: IEventRow
}

export const insertEventQuery = sql<IInsertEventQuery>`
  INSERT INTO workflow_events (
    run_id,
    step_key,
    event_type,
    payload
  ) VALUES (
    $runId,
    $stepKey,
    $eventType,
    $payload
  )
  RETURNING
    id,
    run_id AS "runId",
    step_key AS "stepKey",
    event_type AS "eventType",
    payload,
    created_at AS "createdAt"
`

export interface ICountOpenWaitsQuery {
  params: void
  result: { waitCount: number }
}

export const countOpenWaitsQuery = sql<ICountOpenWaitsQuery>`
  SELECT COUNT(*)::int AS "waitCount"
  FROM workflow_waits
  WHERE status = 'open'
`
