import type { StoreContext } from "./context.js"
import type { JsonObject, JsonValue } from "../../types/json.js"
import type { WorkflowRunRecord } from "../../types/workflow.js"
import {
  startRunIdempotent as startRunIdempotentQuery,
  getRunByDefinitionAndIdempotencyKey as getRunByDefinitionAndIdempotencyKeyQuery,
  insertEvent as insertEventQuery,
  insertRun as insertRunQuery,
  getRunById as getRunByIdQuery,
  getRunEvents as getRunEventsQuery,
  completeRun as completeRunQuery,
  continueAsNewCompleteSource as continueAsNewCompleteSourceQuery,
  continueAsNewInsertRun as continueAsNewInsertRunQuery,
  continueAsNewSetResult as continueAsNewSetResultQuery,
  continueAsNewCompleteAttempt as continueAsNewCompleteAttemptQuery,
  failRun as failRunQuery,
  retryRun as retryRunQuery,
  getRunByIdForUpdate as getRunByIdForUpdateQuery,
  requestCancelRun as requestCancelRunQuery,
  listChildRuns as listChildRunsQuery,
  getStepAttemptByIdForRun as getStepAttemptByIdForRunQuery,
  insertBranchedRun as insertBranchedRunQuery,
  markRunSuperseded as markRunSupersededQuery,
  getChildRun as getChildRunQuery,
  markRunCompensationFailed as markRunCompensationFailedQuery,
} from "../../queries/workflow-store.queries.js"
import {
  mapRun,
  mapEvent,
  requireRow,
  terminalRunStatuses,
  mapAttempt,
  type IRunRow,
} from "./mappers.js"
import { withTransaction } from "../db.js"
import { getActiveTraceContext, createTraceAttributes } from "../tracing.js"
import { LostLeaseError } from "./budget.js"

export const createRunsMethods = (ctx: StoreContext) => {
  const { db, notifyRunnable, notifyRunEvent, withStoreSpan, self } = ctx

  const startRun = async (args: {
    parentRunId?: string | null
    parentStepKey?: string | null
    definitionName: string
    definitionVersion: number
    taskQueue: string
    priority: number
    input: JsonObject
    currentStepKey: string
    idempotencyKey?: string | null
    traceContext?: string | null
  }) =>
    withStoreSpan(
      {
        name: "start_run",
        attributes: createTraceAttributes({
          operation: "store.start_run",
          workflowName: args.definitionName,
          workflowVersion: args.definitionVersion,
          stepKey: args.currentStepKey,
          taskQueue: args.taskQueue,
        }),
      },
      () =>
        withTransaction(db, async (client) => {
          const traceContext = args.traceContext ?? getActiveTraceContext() ?? null
          const params = {
            ...args,
            traceContext,
          }

          if (args.idempotencyKey) {
            const [idempotentRow] = await startRunIdempotentQuery.run(params, client)

            if (idempotentRow) {
              const run = mapRun(idempotentRow as unknown as IRunRow)

              if (idempotentRow.inserted) {
                await insertEventQuery.run(
                  {
                    runId: run.id,
                    stepKey: run.currentStepKey,
                    eventType: "run.started",
                    payload: {},
                  },
                  client
                )

                await notifyRunnable()
                await notifyRunEvent(run.id)
              }

              return run
            }

            const [existingRow] =
              await getRunByDefinitionAndIdempotencyKeyQuery.run(
                {
                  definitionName: args.definitionName,
                  idempotencyKey: args.idempotencyKey,
                },
                client
              )

            if (existingRow) {
              return mapRun(existingRow)
            }
          }

          const [runRow] = await insertRunQuery.run(params, client)
          const run = mapRun(requireRow(runRow, "Failed to insert workflow run"))

          await insertEventQuery.run(
            {
              runId: run.id,
              stepKey: run.currentStepKey,
              eventType: "run.started",
              payload: {},
            },
            client
          )

          await notifyRunnable()
          await notifyRunEvent(run.id)
          return run
        })
    )

  const getRun = async (runId: string) => {
    return withStoreSpan(
      {
        name: "get_run",
        attributes: createTraceAttributes({
          operation: "store.get_run",
          runId,
        }),
      },
      async () => {
        const [row] = await getRunByIdQuery.run({ runId }, db)
        return row ? mapRun(row) : null
      }
    )
  }

  const getRunEvents = async (runId: string) => {
    return withStoreSpan(
      {
        name: "get_run_events",
        attributes: createTraceAttributes({
          operation: "store.get_run_events",
          runId,
        }),
      },
      async () => {
        const rows = await getRunEventsQuery.run({ runId }, db)
        return rows.map(mapEvent)
      }
    )
  }

  const completeRun = async (args: {
    runId: string
    stepKey: string
    workerId: string
    context: JsonObject
    result: JsonValue | null
  }) =>
    withStoreSpan(
      {
        name: "complete_run",
        attributes: createTraceAttributes({
          operation: "store.complete_run",
          runId: args.runId,
          stepKey: args.stepKey,
          workerId: args.workerId,
        }),
      },
      async () => {
        const [row] = await completeRunQuery.run(
          {
            ...args,
            eventType: "run.completed",
            eventPayload: {},
          },
          db
        )

        if (!row) {
          throw new LostLeaseError("Failed to complete run under active lease")
        }

        const run = (await getRun(mapRun(row).id)) ?? mapRun(row)
        await notifyRunEvent(run.id)
        await self.wakeParentForChild(run)
        return run
      }
    )

  const failRun = async (args: {
    runId: string
    stepKey: string
    workerId: string
    attemptId: string
    error: JsonObject
  }) =>
    withStoreSpan(
      {
        name: "fail_run",
        attributes: createTraceAttributes({
          operation: "store.fail_run",
          runId: args.runId,
          stepKey: args.stepKey,
          workerId: args.workerId,
        }),
      },
      async () => {
        const [row] = await failRunQuery.run(
          {
            ...args,
            eventType: "step.failed",
            eventPayload: args.error,
          },
          db
        )

        if (!row) {
          throw new LostLeaseError("Failed to mark run failed under active lease")
        }

        const run = mapRun(row)
        await notifyRunEvent(run.id)
        return run
      }
    )

  const retryRun = async (runId: string) =>
    withStoreSpan(
      {
        name: "retry_run",
        attributes: createTraceAttributes({
          operation: "store.retry_run",
          runId,
        }),
      },
      async () => {
        const [row] = await retryRunQuery.run(
          {
            runId,
            eventType: "run.retried",
            eventPayload: {},
          },
          db
        )

        if (!row) {
          return null
        }

        const run = mapRun(row)
        await notifyRunnable()
        return run
      }
    )

  const branchRun = async (args: {
    runId: string
    attemptId: string
    mode: "rewind" | "fork"
  }) =>
    withStoreSpan(
      {
        name: "branch_run",
        attributes: createTraceAttributes({
          operation: args.mode === "rewind" ? "store.rewind_run" : "store.fork_run",
          runId: args.runId,
        }),
      },
      () =>
        withTransaction(db, async (client) => {
          const [sourceRunRow] = await getRunByIdForUpdateQuery.run(
            { runId: args.runId },
            client
          )

          if (!sourceRunRow) {
            return null
          }

          const sourceRun = mapRun(sourceRunRow)

          if (args.mode === "rewind" && sourceRun.supersededByRunId) {
            throw new Error(`Run "${args.runId}" has already been rewound`)
          }

          if (!terminalRunStatuses.has(sourceRun.status)) {
            if (args.mode === "rewind") {
              const cancelTree = async (runId: string) => {
                await requestCancelRunQuery.run(
                  {
                    runId,
                    mode: "hard",
                    eventType: "run.canceled",
                    eventPayload: { reason: "Superseded by rewind" },
                  },
                  client
                )

                const childRows = await listChildRunsQuery.run({ parentRunId: runId }, client)
                for (const childRow of childRows) {
                  await cancelTree(childRow.id)
                }
              }

              await cancelTree(sourceRun.id)
            } else {
              throw new Error(
                `Run "${args.runId}" must be terminal before ${args.mode}`
              )
            }
          }

          const [attemptRow] = await getStepAttemptByIdForRunQuery.run(
            {
              runId: args.runId,
              attemptId: args.attemptId,
            },
            client
          )

          if (!attemptRow) {
            throw new Error(
              `Attempt "${args.attemptId}" does not belong to run "${args.runId}"`
            )
          }

          const attempt = mapAttempt(attemptRow)

          if (attempt.kind !== "forward") {
            throw new Error("Only forward attempts can be rewound or forked")
          }

          const [nextRunRow] = await insertBranchedRunQuery.run(
            {
              branchedFromRunId: sourceRun.id,
              branchedFromAttemptRunId: attempt.runId,
              branchedFromAttemptId: attempt.id,
              definitionName: sourceRun.definitionName,
              definitionVersion: sourceRun.definitionVersion,
              taskQueue: sourceRun.taskQueue,
              priority: sourceRun.priority,
              currentStepKey: attempt.stepKey,
              input: sourceRun.input,
              context: attempt.contextBefore,
              traceContext: getActiveTraceContext() ?? null,
            },
            client
          )

          const nextRun = mapRun(requireRow(nextRunRow, "Failed to insert branched run"))

          if (args.mode === "rewind") {
            const [supersededRow] = await markRunSupersededQuery.run(
              {
                runId: sourceRun.id,
                supersededByRunId: nextRun.id,
              },
              client
            )

            if (!supersededRow) {
              throw new Error(`Run "${args.runId}" could not be marked as rewound`)
            }
          }

          await insertEventQuery.run(
            {
              runId: sourceRun.id,
              stepKey: attempt.stepKey,
              eventType: args.mode === "rewind" ? "run.rewound" : "run.forked",
              payload: {
                attemptId: attempt.id,
                stepKey: attempt.stepKey,
                branchedRunId: nextRun.id,
              },
            },
            client
          )

          await insertEventQuery.run(
            {
              runId: nextRun.id,
              stepKey: nextRun.currentStepKey,
              eventType: "run.started",
              payload: {
                branchMode: args.mode,
                branchedFromRunId: sourceRun.id,
                branchedFromAttemptId: attempt.id,
                stepSeq: attempt.stepSeq,
              },
            },
            client
          )

          await notifyRunnable()
          await notifyRunEvent(sourceRun.id)
          await notifyRunEvent(nextRun.id)
          return nextRun
        })
    )

  const continueAsNew = async (args: {
    runId: string
    stepKey: string
    workerId: string
    attemptId: string
    context: JsonObject
    currentStepKey: string
    input: JsonObject
    taskQueue: string
    priority: number
  }) =>
    withStoreSpan(
      {
        name: "continue_as_new",
        attributes: createTraceAttributes({
          operation: "store.continue_as_new",
          runId: args.runId,
          stepKey: args.stepKey,
          workerId: args.workerId,
          taskQueue: args.taskQueue,
        }),
      },
      () =>
        withTransaction(db, async (client) => {
          const [completedRow] = await continueAsNewCompleteSourceQuery.run(
            {
              runId: args.runId,
              stepKey: args.stepKey,
              workerId: args.workerId,
              context: args.context,
            },
            client
          )

          if (!completedRow) {
            throw new LostLeaseError("Failed to continue run under active lease")
          }

          const completedRun = mapRun(completedRow)

          const [nextRunRow] = await continueAsNewInsertRunQuery.run(
            {
              continuedFromRunId: completedRun.id,
              definitionName: completedRun.definitionName,
              definitionVersion: completedRun.definitionVersion,
              taskQueue: args.taskQueue,
              priority: args.priority,
              currentStepKey: args.currentStepKey,
              input: args.input,
              traceContext: getActiveTraceContext() ?? null,
            },
            client
          )

          const nextRun = mapRun(
            requireRow(nextRunRow, "Failed to insert continued run")
          )

          await continueAsNewSetResultQuery.run(
            {
              runId: completedRun.id,
              continuedRunId: nextRun.id,
            },
            client
          )

          await continueAsNewCompleteAttemptQuery.run(
            {
              attemptId: args.attemptId,
              continuedRunId: nextRun.id,
              runId: args.runId,
            },
            client
          )

          await insertEventQuery.run(
            {
              runId: completedRun.id,
              stepKey: args.stepKey,
              eventType: "run.continued_as_new",
              payload: {
                continuedRunId: nextRun.id,
              },
            },
            client
          )

          await insertEventQuery.run(
            {
              runId: nextRun.id,
              stepKey: nextRun.currentStepKey,
              eventType: "run.started",
              payload: {
                continuedFromRunId: completedRun.id,
              },
            },
            client
          )

          await notifyRunnable()
          await notifyRunEvent(completedRun.id)
          await notifyRunEvent(nextRun.id)
          return nextRun
        })
    )

  const getChildRun = async (args: {
    parentRunId: string
    parentStepKey: string
  }) =>
    withStoreSpan(
      {
        name: "get_child_run",
        attributes: createTraceAttributes({
          operation: "store.get_child_run",
          runId: args.parentRunId,
          stepKey: args.parentStepKey,
        }),
      },
      async () => {
        const [row] = await getChildRunQuery.run(args, db)

        if (!row) {
          return null
        }

        const run = mapRun(row)
        await notifyRunnable()
        await notifyRunEvent(run.id)
        return run
      }
    )

  const markRunCompensationFailed = async (args: {
    runId: string
    stepKey: string
    error: JsonObject
  }) => {
    const [row] = await markRunCompensationFailedQuery.run(
      {
        runId: args.runId,
        stepKey: args.stepKey,
        error: args.error,
        eventType: "run.compensation_failed",
        eventPayload: args.error,
      },
      db
    )

    if (!row) {
      throw new Error(
        `Failed to mark run "${args.runId}" compensation failure state`
      )
    }

    const run = mapRun(row)
    await notifyRunEvent(run.id)
    return run
  }

  return {
    startRun,
    getRun,
    getRunEvents,
    completeRun,
    failRun,
    retryRun,
    branchRun,
    continueAsNew,
    getChildRun,
    markRunCompensationFailed,
  }
}
