import type { PoolClient } from "pg"

import {
  claimNextRunnableRunQuery,
  completeStepAttemptQuery,
  countOpenWaitsQuery,
  getLastStepAttemptQuery,
  getOpenWaitByCorrelationKeyQuery,
  getRunByIdQuery,
  getRunEventsQuery,
  insertEventQuery,
  insertRunQuery,
  insertStepAttemptQuery,
  insertWaitQuery,
  markRunCompletedQuery,
  markRunFailedQuery,
  markRunWaitingQuery,
  markWaitResumedQuery,
  updateRunForNextStepQuery,
  type IAttemptRow,
  type IEventRow,
  type IInsertRunQuery,
  type IWaitRow,
} from "../queries/workflow-store.queries.js"
import type { JsonObject, JsonValue } from "../types/json.js"
import type {
  StepAttemptStatus,
  WorkflowEventRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepAttemptRecord,
  WorkflowWaitRecord,
} from "../types/workflow.js"
import type { Database } from "./db.js"
import { withTransaction } from "./db.js"

const requireRow = <T>(row: T | undefined, message: string): T => {
  if (!row) {
    throw new Error(message)
  }

  return row
}

const mapRun = (row: IInsertRunQuery["result"]): WorkflowRunRecord => ({
  ...row,
  status: row.status as WorkflowRunStatus,
  input: row.input as JsonObject,
  context: row.context as JsonObject,
  result: row.result as JsonValue | null,
  error: row.error as JsonValue | null,
})

const mapAttempt = (row: IAttemptRow): WorkflowStepAttemptRecord => ({
  ...row,
  status: row.status as StepAttemptStatus,
  input: row.input as JsonObject,
  output: row.output as JsonValue | null,
  error: row.error as JsonValue | null,
})

const mapWait = (row: IWaitRow): WorkflowWaitRecord => ({
  ...row,
  payload: row.payload as JsonValue | null,
})

const mapEvent = (row: IEventRow): WorkflowEventRecord => ({
  ...row,
  payload: row.payload as JsonObject,
})

const insertStepAttemptRecord = async (
  client: PoolClient,
  args: {
    runId: string
    stepKey: string
    input: JsonObject
  }
) => {
  const [countRow] = await getLastStepAttemptQuery.run(
    { runId: args.runId, stepKey: args.stepKey },
    client
  )
  const attempt = (countRow?.lastAttempt ?? 0) + 1
  const [row] = await insertStepAttemptQuery.run(
    {
      runId: args.runId,
      stepKey: args.stepKey,
      attempt,
      input: args.input,
    },
    client
  )

  return mapAttempt(requireRow(row, "Failed to insert step attempt"))
}

export const createWorkflowStore = (db: Database) => {
  const insertRun = async (args: {
    definitionName: string
    definitionVersion: number
    input: JsonObject
    currentStepKey: string
  }) => {
    const [row] = await insertRunQuery.run(args, db)
    return mapRun(requireRow(row, "Failed to insert workflow run"))
  }

  const getRun = async (runId: string) => {
    const [row] = await getRunByIdQuery.run({ runId }, db)
    return row ? mapRun(row) : null
  }

  const getRunEvents = async (runId: string) => {
    const rows = await getRunEventsQuery.run({ runId }, db)
    return rows.map(mapEvent)
  }

  const claimNextRunnableRun = async (args: {
    workerId: string
    leaseMs: number
  }) =>
    withTransaction(db, async (client) => {
      const [row] = await claimNextRunnableRunQuery.run(args, client)
      return row ? mapRun(row) : null
    })

  const insertAttempt = async (args: {
    runId: string
    stepKey: string
    input: JsonObject
  }) => withTransaction(db, (client) => insertStepAttemptRecord(client, args))

  const completeAttempt = async (args: {
    attemptId: string
    output: JsonValue | null
    status: "completed" | "failed"
    error: JsonValue | null
  }) => {
    const [row] = await completeStepAttemptQuery.run(args, db)
    return mapAttempt(requireRow(row, "Failed to complete step attempt"))
  }

  const updateRunForNextStep = async (args: {
    runId: string
    context: JsonObject
    nextStepKey: string
  }) => {
    const [row] = await updateRunForNextStepQuery.run(args, db)
    return mapRun(requireRow(row, "Failed to advance workflow run"))
  }

  const markRunWaiting = async (args: {
    runId: string
    context: JsonObject
    stepKey: string
  }) => {
    const [row] = await markRunWaitingQuery.run(args, db)
    return mapRun(requireRow(row, "Failed to mark workflow run waiting"))
  }

  const markRunCompleted = async (args: {
    runId: string
    context: JsonObject
    result: JsonValue | null
  }) => {
    const [row] = await markRunCompletedQuery.run(args, db)
    return mapRun(requireRow(row, "Failed to mark workflow run completed"))
  }

  const markRunFailed = async (args: {
    runId: string
    error: JsonValue
  }) => {
    const [row] = await markRunFailedQuery.run(args, db)
    return mapRun(requireRow(row, "Failed to mark workflow run failed"))
  }

  const insertWait = async (args: {
    runId: string
    stepKey: string
    correlationKey: string
    payload: JsonValue | null
  }) => {
    const [row] = await insertWaitQuery.run(args, db)
    return mapWait(requireRow(row, "Failed to insert workflow wait"))
  }

  const getOpenWaitByCorrelationKey = async (correlationKey: string) => {
    const [row] = await getOpenWaitByCorrelationKeyQuery.run(
      { correlationKey },
      db
    )
    return row ? mapWait(row) : null
  }

  const markWaitResumed = async (waitId: string) => {
    const [row] = await markWaitResumedQuery.run({ waitId }, db)
    return mapWait(requireRow(row, "Failed to mark workflow wait resumed"))
  }

  const insertEvent = async (args: {
    runId: string
    stepKey: string | null
    eventType: string
    payload?: JsonObject
  }) => {
    const [row] = await insertEventQuery.run(
      {
        runId: args.runId,
        stepKey: args.stepKey,
        eventType: args.eventType,
        payload: args.payload ?? {},
      },
      db
    )

    return mapEvent(requireRow(row, "Failed to insert workflow event"))
  }

  const countOpenWaits = async () => {
    const [row] = await countOpenWaitsQuery.run(undefined, db)
    return Number(requireRow(row, "Failed to count open waits").waitCount)
  }

  return {
    claimNextRunnableRun,
    completeAttempt,
    countOpenWaits,
    getOpenWaitByCorrelationKey,
    getRun,
    getRunEvents,
    insertAttempt,
    insertEvent,
    insertRun,
    insertWait,
    markRunCompleted,
    markRunFailed,
    markRunWaiting,
    markWaitResumed,
    updateRunForNextStep,
  }
}

export type WorkflowStore = ReturnType<typeof createWorkflowStore>
