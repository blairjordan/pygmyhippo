import type { PoolClient } from "pg"
import type { StoreContext } from "./context.js"
import type { JsonObject, JsonValue } from "../../types/json.js"
import type { StepAttemptKind } from "../../types/workflow.js"
import {
  getLastStepAttempt as getLastStepAttemptQuery,
  getRunByIdForUpdate as getRunByIdForUpdateQuery,
  getLastStepSequence as getLastStepSequenceQuery,
  insertStepAttempt as insertStepAttemptQuery,
  insertEvent as insertEventQuery,
  getRunAttempts as getRunAttemptsQuery,
  completeStandaloneStepAttempt as completeStandaloneStepAttemptQuery,
  failStandaloneStepAttempt as failStandaloneStepAttemptQuery,
  advanceTaskStep as advanceTaskStepQuery,
  scheduleSleep as scheduleSleepQuery,
  scheduleRetry as scheduleRetryQuery,
} from "../../queries/workflow-store.queries.js"
import {
  mapAttempt,
  mapRun,
  mapEvent,
  requireRow,
} from "./mappers.js"
import { getActiveTraceContext, createTraceAttributes } from "../tracing.js"
import { withTransaction, type Database } from "../db.js"
import { LostLeaseError } from "./budget.js"

export const insertAttempt = async (
  client: PoolClient,
  args: {
    runId: string
    stepKey: string
    kind: StepAttemptKind
    input: JsonObject
  }
) => {
  const [countRow] = await getLastStepAttemptQuery.run(
    { runId: args.runId, stepKey: args.stepKey, kind: args.kind },
    client
  )
  const [runRow] = await getRunByIdForUpdateQuery.run({ runId: args.runId }, client)
  const run = mapRun(requireRow(runRow, `Run "${args.runId}" not found`))
  const [stepSeqRow] = await getLastStepSequenceQuery.run(
    { runId: args.runId },
    client
  )
  const attempt = (countRow?.lastAttempt ?? 0) + 1
  const [row] = await insertStepAttemptQuery.run(
    {
      runId: args.runId,
      stepKey: args.stepKey,
      kind: args.kind,
      stepSeq: (stepSeqRow?.lastStepSeq ?? 0) + 1,
      attempt,
      contextBefore: run.context,
      input: args.input,
      traceContext: getActiveTraceContext() ?? null,
    },
    client
  )

  return mapAttempt(requireRow(row, "Failed to insert step attempt"))
}

export const insertStepEvent = async (args: {
  runId: string
  stepKey: string
  stepAttemptId: string
  type: string
  data: JsonValue
  executor: Database | PoolClient
}) => {
  if (args.type.trim().length === 0) {
    throw new Error("Step event type must not be empty")
  }

  const [row] = await insertEventQuery.run(
    {
      runId: args.runId,
      stepKey: args.stepKey,
      eventType: `step.emit:${args.type}`,
      payload: {
        type: args.type,
        data: args.data,
        stepKey: args.stepKey,
        stepAttemptId: args.stepAttemptId,
      },
    },
    args.executor
  )
  return mapEvent(requireRow(row, "Failed to insert step event"))
}

export const createAttemptsMethods = (ctx: StoreContext) => {
  const { db, notifyRunnable, notifyRunEvent, withStoreSpan } = ctx

  const getRunAttempts = async (runId: string) => {
    return withStoreSpan(
      {
        name: "get_run_attempts",
        attributes: createTraceAttributes({
          operation: "store.get_run_attempts",
          runId,
        }),
      },
      async () => {
        const rows = await getRunAttemptsQuery.run({ runId }, db)
        return rows.map(mapAttempt)
      }
    )
  }

  const beginStepAttempt = async (args: {
    runId: string
    stepKey: string
    kind?: StepAttemptKind
    input: JsonObject
  }) =>
    withStoreSpan(
      {
        name: "begin_step_attempt",
        attributes: createTraceAttributes({
          operation: "store.begin_step_attempt",
          runId: args.runId,
          stepKey: args.stepKey,
          stepKind: args.kind ?? "forward",
        }),
      },
      () =>
        withTransaction(db, (client) =>
          insertAttempt(client, {
            ...args,
            kind: args.kind ?? "forward",
          })
        )
    )

  const completeStepAttempt = async (args: {
    runId: string
    stepKey: string
    attemptId: string
    output: JsonValue | null
  }) => {
    const [row] = await completeStandaloneStepAttemptQuery.run(
      {
        runId: args.runId,
        attemptId: args.attemptId,
        output: args.output,
      },
      db
    )

    if (!row) {
      throw new Error(`Failed to complete step attempt "${args.attemptId}"`)
    }

    await insertEventQuery.run(
      {
        runId: args.runId,
        stepKey: args.stepKey,
        eventType: "compensation.completed",
        payload: {},
      },
      db
    )
    await notifyRunEvent(args.runId)
    return mapAttempt(row)
  }

  const failStepAttempt = async (args: {
    runId: string
    stepKey: string
    attemptId: string
    error: JsonObject
  }) => {
    const [row] = await failStandaloneStepAttemptQuery.run(
      {
        runId: args.runId,
        attemptId: args.attemptId,
        error: args.error,
      },
      db
    )

    if (!row) {
      throw new Error(`Failed to fail step attempt "${args.attemptId}"`)
    }

    await insertEventQuery.run(
      {
        runId: args.runId,
        stepKey: args.stepKey,
        eventType: "compensation.failed",
        payload: args.error,
      },
      db
    )
    await notifyRunEvent(args.runId)
    return mapAttempt(row)
  }

  const advanceTaskStep = async (args: {
    runId: string
    stepKey: string
    workerId: string
    attemptId: string
    nextStepKey: string
    context: JsonObject
    output: JsonValue | null
  }) =>
    withStoreSpan(
      {
        name: "advance_task_step",
        attributes: {
          ...createTraceAttributes({
            operation: "store.advance_task_step",
            runId: args.runId,
            stepKey: args.stepKey,
            workerId: args.workerId,
          }),
          "workflow.next_step.key": args.nextStepKey,
        },
      },
      async () => {
        const [row] = await advanceTaskStepQuery.run(
          {
            ...args,
            eventType: "step.completed",
            eventPayload: { nextStepKey: args.nextStepKey },
          },
          db
        )

        if (!row) {
          throw new LostLeaseError("Failed to advance task step under active lease")
        }

        const run = mapRun(row)
        await notifyRunnable()
        await notifyRunEvent(run.id)
        return run
      }
    )

  const scheduleSleep = async (args: {
    runId: string
    stepKey: string
    workerId: string
    nextStepKey: string
    availableAt: Date
  }) => {
    const [row] = await scheduleSleepQuery.run(
      {
        ...args,
        eventType: "step.scheduled",
        eventPayload: { availableAt: args.availableAt.toISOString() },
      },
      db
    )

    if (!row) {
      throw new LostLeaseError("Failed to schedule sleep step under active lease")
    }

    const run = mapRun(row)
    await notifyRunEvent(run.id)
    return run
  }

  const scheduleRetry = async (args: {
    runId: string
    stepKey: string
    workerId: string
    attemptId: string
    availableAt: Date
    error: JsonObject
  }) =>
    withStoreSpan(
      {
        name: "schedule_retry",
        attributes: createTraceAttributes({
          operation: "store.schedule_retry",
          runId: args.runId,
          stepKey: args.stepKey,
          workerId: args.workerId,
        }),
      },
      async () => {
        const [row] = await scheduleRetryQuery.run(
          {
            ...args,
            eventType: "step.retry_scheduled",
            eventPayload: { availableAt: args.availableAt.toISOString() },
          },
          db
        )

        if (!row) {
          throw new LostLeaseError("Failed to schedule retry under active lease")
        }

        const run = mapRun(row)
        await notifyRunEvent(run.id)
        return run
      }
    )

  const emitStepEvent = async (args: {
    runId: string
    stepKey: string
    stepAttemptId: string
    type: string
    data: JsonValue
  }) => {
    const event = await insertStepEvent({
      ...args,
      executor: db,
    })
    await notifyRunEvent(args.runId)
    return event
  }

  return {
    getRunAttempts,
    beginStepAttempt,
    completeStepAttempt,
    failStepAttempt,
    advanceTaskStep,
    scheduleSleep,
    scheduleRetry,
    emitStepEvent,
  }
}
