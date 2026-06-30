import type { JsonObject, JsonValue } from "../../types/json.js"
import type {
  SignalRecord,
  StepAttemptKind,
  StepAttemptStatus,
  WorkflowCancelMode,
  WorkflowEventRecord,
  WorkflowOutboxRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowScheduleRecord,
  WorkflowStepAttemptRecord,
  WorkflowUsageRecord,
  WorkflowWaitRecord,
} from "../../types/workflow.js"

export type IRunRow = {
  id: string
  parentRunId?: string | null
  parentStepKey?: string | null
  continuedFromRunId?: string | null
  branchedFromRunId?: string | null
  branchedFromAttemptRunId?: string | null
  branchedFromAttemptId?: string | null
  supersededByRunId?: string | null
  definitionName: string
  definitionVersion: number
  taskQueue?: string
  priority?: number
  status: string
  currentStepKey: string | null
  input: JsonValue
  context: JsonValue
  result: JsonValue | null
  error: JsonValue | null
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  cancelRequestedAt?: Date | null
  cancelMode?: string | null
  availableAt: Date
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  traceContext?: string | null
}

export type IAttemptRow = {
  id: string
  runId: string
  stepKey: string
  kind: StepAttemptKind
  stepSeq?: number
  attempt: number
  status: string
  contextBefore?: JsonValue
  input: JsonValue
  output: JsonValue | null
  error: JsonValue | null
  startedAt: Date
  lastHeartbeatAt?: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  traceContext?: string | null
  externalSessionId?: string | null
  externalSessionKind?: string | null
}

export type IWaitRow = {
  id: string
  runId: string
  stepKey: string
  correlationKey: string
  status: "open" | "resumed" | "expired" | "canceled"
  payload: JsonValue | null
  resumePayload: JsonValue | null
  resumeOutput: JsonValue | null
  expiresAt?: Date | null
  createdAt: Date
  updatedAt: Date
  resumedAt: Date | null
  externalSessionId?: string | null
  externalSessionKind?: string | null
}

export type IEventRow = {
  id: number | string
  runId: string
  stepKey: string | null
  eventType: string
  payload: JsonValue
  createdAt: Date
}

export type IUsageRow = {
  id: string
  runId: string
  stepAttemptId: string | null
  resource: string
  amount: string
  costUsd: string | null
  dimension: string | null
  recordedAt: Date
}

export const requireRow = <T>(row: T | undefined, message: string): T => {
  if (!row) {
    throw new Error(message)
  }

  return row
}

export const assertJsonObject = (
  value: JsonValue,
  message: string
): JsonObject => {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(message)
  }

  return value as JsonObject
}

export const mapRun = (row: IRunRow): WorkflowRunRecord => ({
  ...row,
  parentRunId: row.parentRunId ?? null,
  parentStepKey:
    "parentStepKey" in row && typeof row.parentStepKey === "string"
      ? row.parentStepKey
      : null,
  continuedFromRunId: row.continuedFromRunId ?? null,
  branchedFromRunId: row.branchedFromRunId ?? null,
  branchedFromAttemptRunId: row.branchedFromAttemptRunId ?? null,
  branchedFromAttemptId: row.branchedFromAttemptId ?? null,
  supersededByRunId: row.supersededByRunId ?? null,
  taskQueue: row.taskQueue ?? "default",
  priority: row.priority ?? 0,
  status: row.status as WorkflowRunStatus,
  input: assertJsonObject(row.input, "Run input must be a JSON object"),
  context: assertJsonObject(row.context, "Run context must be a JSON object"),
  result: row.result,
  error: row.error,
  cancelRequestedAt: row.cancelRequestedAt ?? null,
  cancelMode: (row.cancelMode as WorkflowCancelMode | null | undefined) ?? null,
  traceContext: row.traceContext ?? null,
})

export const mapAttempt = (row: IAttemptRow): WorkflowStepAttemptRecord => ({
  ...row,
  kind: row.kind as StepAttemptKind,
  stepSeq: row.stepSeq ?? 0,
  status: row.status as StepAttemptStatus,
  contextBefore: assertJsonObject(
    row.contextBefore ?? {},
    "Attempt contextBefore must be a JSON object"
  ),
  input: assertJsonObject(row.input, "Attempt input must be a JSON object"),
  output: row.output,
  error: row.error,
  lastHeartbeatAt: row.lastHeartbeatAt ?? null,
  traceContext: row.traceContext ?? null,
  externalSessionId: row.externalSessionId ?? null,
  externalSessionKind: row.externalSessionKind ?? null,
})

export const mapWait = (row: IWaitRow): WorkflowWaitRecord => ({
  ...row,
  payload: row.payload,
  resumePayload: row.resumePayload,
  resumeOutput: row.resumeOutput,
  expiresAt: row.expiresAt ?? null,
  externalSessionId: row.externalSessionId ?? null,
  externalSessionKind: row.externalSessionKind ?? null,
})

export const mapSignal = (row: {
  id: string
  runId: string
  signalName: string
  payload: JsonValue | null
  consumedAt: Date | null
  createdAt: Date
  updatedAt: Date
}): SignalRecord => ({
  ...row,
  payload: row.payload,
})

export const mapEvent = (row: IEventRow): WorkflowEventRecord => ({
  ...row,
  id: Number(row.id),
  payload: assertJsonObject(row.payload, "Event payload must be a JSON object"),
})

export const mapUsage = (row: IUsageRow): WorkflowUsageRecord => ({
  ...row,
  amount: Number(row.amount),
  costUsd: row.costUsd === null ? null : Number(row.costUsd),
})

export const mapSchedule = (row: {
  id: string
  workflowName: string
  cronExpression: string
  payload: JsonValue
  taskQueue?: string
  priority?: number
  active: boolean
  nextFireAt: Date
  createdAt: Date
  updatedAt: Date
}): WorkflowScheduleRecord => ({
  ...row,
  taskQueue: row.taskQueue ?? "default",
  priority: row.priority ?? 0,
  payload: assertJsonObject(row.payload, "Schedule payload must be a JSON object"),
})

export const mapOutbox = (row: {
  id: string
  runId: string | null
  topic: string
  payload: JsonValue
  availableAt: Date
  deliveredAt: Date | null
  createdAt: Date
  updatedAt: Date
}): WorkflowOutboxRecord => ({
  ...row,
  payload: assertJsonObject(row.payload, "Outbox payload must be a JSON object"),
})

export const terminalRunStatuses = new Set<WorkflowRunStatus>([
  "completed",
  "failed",
  "compensation_failed",
  "canceled",
  "exhausted_budget",
])
