import type { PoolClient } from "pg"
import type { StoreContext } from "./context.js"
import type { JsonObject, JsonValue } from "../../types/json.js"
import type {
  RetryPolicy,
  StepExecutionContext,
  TaskStepResult,
  WorkflowBudget,
  WorkflowRunRecord,
  StepExecutionKV,
} from "../../types/workflow.js"
import {
  getRunByIdForUpdate as getRunByIdForUpdateQuery,
  getUsageTotals as getUsageTotalsQuery,
  exhaustRunBudget as exhaustRunBudgetQuery,
  completeTransactionalTask as completeTransactionalTaskQuery,
  retryTransactionalTask as retryTransactionalTaskQuery,
  failTransactionalTask as failTransactionalTaskQuery,
  insertEvent as insertEventQuery,
} from "../../queries/workflow-store.queries.js"
import { mapRun, mapEvent, requireRow } from "./mappers.js"
import { withTransaction } from "../db.js"
import { createTraceAttributes } from "../tracing.js"
import { TransactionBudgetExceededError } from "./budget.js"
import { insertAttempt } from "./attempts.js"

const withPromiseTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string
) => {
  if (timeoutMs === undefined) {
    return promise
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)

    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

const insertStepEvent = async (args: {
  runId: string
  stepKey: string
  stepAttemptId: string
  type: string
  data: JsonValue
  executor: any
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

export const createExecutionMethods = (ctx: StoreContext) => {
  const { db, notifyRunnable, notifyRunEvent, tracer, self } = ctx

  const executeTransactionalTask = async (args: {
    run: WorkflowRunRecord
    stepKey: string
    workerId: string
    nextStepKey?: string
    retryPolicy?: RetryPolicy
    budget?: WorkflowBudget
    timeoutMs?: number
    resolveRetryAvailableAt: (input: {
      attempt: number
      retryPolicy: RetryPolicy
    }) => Date
    getErrorTag: (error: unknown) => string | null
    asErrorPayload: (error: unknown) => JsonObject
    mergeContext: (left: JsonObject, right?: JsonObject) => JsonObject
    runTask: (
      context: StepExecutionContext
    ) => Promise<TaskStepResult> | TaskStepResult
  }) =>
    ctx.withStoreSpan(
      {
        name: "execute_transactional_task",
        attributes: createTraceAttributes({
          operation: "store.execute_transactional_task",
          workflowName: args.run.definitionName,
          workflowVersion: args.run.definitionVersion,
          runId: args.run.id,
          stepKey: args.stepKey,
          stepKind: "task",
          taskQueue: args.run.taskQueue,
          workerId: args.workerId,
        }),
      },
      async () => {
        const outcome = await withTransaction(db, async (client) => {
          const [lockedRunRow] = await getRunByIdForUpdateQuery.run(
            { runId: args.run.id },
            client
          )

          if (!lockedRunRow) {
            return { outcome: "lost_lease" as const, run: null }
          }

          const lockedRun = mapRun(lockedRunRow)

          if (
            lockedRun.currentStepKey !== args.stepKey ||
            lockedRun.leaseOwner !== args.workerId ||
            lockedRun.leaseExpiresAt === null ||
            lockedRun.leaseExpiresAt.getTime() < Date.now()
          ) {
            return { outcome: "lost_lease" as const, run: null }
          }

          const attempt = await insertAttempt(client, {
            runId: args.run.id,
            stepKey: args.stepKey,
            kind: "forward",
            input: {
              workflow: lockedRun.definitionName,
              step: args.stepKey,
              input: lockedRun.input,
              context: lockedRun.context,
            },
          })
          const now = new Date()
          const pendingUsage: any[] = []
          const kv: StepExecutionKV = {
            get: async (key: string) => {
              return self.getRunKV(lockedRun.id, key, client)
            },
            set: async (key: string, value: JsonValue) => {
              await self.setRunKV(lockedRun.id, key, value, client)
            },
            delete: async (key: string) => {
              await self.deleteRunKV(lockedRun.id, key, client)
            },
          }
          const context: StepExecutionContext = {
            run: {
              ...lockedRun,
              kv,
            },
            input: lockedRun.input,
            context: lockedRun.context,
            now,
            attempt: attempt.attempt,
            idempotencyKey: `${lockedRun.id}:${args.stepKey}`,
            heartbeat: async () => false,
            emit: async (event) => {
              await insertStepEvent({
                runId: lockedRun.id,
                stepKey: args.stepKey,
                stepAttemptId: attempt.id,
                type: event.type,
                data: event.data,
                executor: client,
              })
            },
            recordUsage: async (usage) => {
              self.validateUsage(usage)

              const [totalsRow] = await getUsageTotalsQuery.run(
                {
                  runId: lockedRun.id,
                  resource: usage.resource,
                },
                client
              )
              const resourceAmount =
                Number(totalsRow?.resourceAmount ?? 0) +
                pendingUsage
                  .filter((candidate) => candidate.resource === usage.resource)
                  .reduce((total, candidate) => total + candidate.amount, 0) +
                usage.amount
              const costUsd =
                Number(totalsRow?.costUsd ?? 0) +
                pendingUsage.reduce(
                  (total, candidate) => total + (candidate.costUsd ?? 0),
                  0
                ) +
                (usage.costUsd ?? 0)
              const exhausted = self.getBudgetExhaustion({
                budget: args.budget,
                usage,
                resourceAmount,
                costUsd,
              })

              pendingUsage.push(usage)

              if (exhausted) {
                throw new TransactionBudgetExceededError(usage, exhausted)
              }
            },
            db: {
              query: async <T extends object>(
                text: string,
                values: readonly unknown[] = []
              ) => {
                const result = await client.query<T>(text, [...values])
                return {
                  rows: result.rows as T[],
                }
              },
            },
            outbox: {
              enqueue: async (input) => {
                await self.enqueueOutbox({
                  runId: lockedRun.id,
                  topic: input.topic,
                  payload: input.payload,
                  client,
                  ...(input.availableAt === undefined
                    ? {}
                    : { availableAt: input.availableAt }),
                })
              },
            },
            transactional: true,
            kv,
          }

          await client.query("SAVEPOINT hippo_step_body")

          try {
            const result = await tracer.withSpan(
              {
                name: "hippo.workflow.step.run_task",
                attributes: createTraceAttributes({
                  operation: "workflow.step.run_task",
                  workflowName: lockedRun.definitionName,
                  workflowVersion: lockedRun.definitionVersion,
                  runId: lockedRun.id,
                  stepKey: args.stepKey,
                  stepKind: "task",
                  taskQueue: lockedRun.taskQueue,
                  workerId: args.workerId,
                }),
              },
              () =>
                withPromiseTimeout(
                  Promise.resolve(args.runTask(context)),
                  args.timeoutMs,
                  `Task step "${args.stepKey}" in workflow "${lockedRun.definitionName}"`
                )
            )
            const nextStepKey = result.transition ?? args.nextStepKey

            if (!nextStepKey) {
              throw new Error(
                `Task step "${args.stepKey}" in workflow "${lockedRun.definitionName}" did not resolve a next step`
              )
            }

            for (const usage of pendingUsage) {
              const usageResult = await self.recordUsageWithExecutor({
                runId: lockedRun.id,
                stepKey: args.stepKey,
                stepAttemptId: attempt.id,
                usage,
                budget: args.budget,
                executor: client,
              })

              if (usageResult.run) {
                await client.query("RELEASE SAVEPOINT hippo_step_body")
                return {
                  outcome: "exhausted_budget" as const,
                  run: usageResult.run,
                }
              }
            }

            const [updatedRow] = await completeTransactionalTaskQuery.run(
              {
                runId: lockedRun.id,
                stepKey: args.stepKey,
                workerId: args.workerId,
                nextStepKey,
                context: args.mergeContext(lockedRun.context, result.patch),
                output: result.output ?? null,
                attemptId: attempt.id,
              },
              client
            )

            if (!updatedRow) {
              return { outcome: "lost_lease" as const, run: null }
            }

            await client.query("RELEASE SAVEPOINT hippo_step_body")
            return {
              outcome: "completed" as const,
              run: mapRun(updatedRow),
            }
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT hippo_step_body")
            await client.query("RELEASE SAVEPOINT hippo_step_body")

            if (error instanceof TransactionBudgetExceededError) {
              let exhaustedRun: WorkflowRunRecord | null = null

              for (const usage of pendingUsage) {
                const usageRecord = await self.insertUsage({
                  runId: lockedRun.id,
                  stepAttemptId: attempt.id,
                  usage,
                  executor: client,
                })

                if (usage === error.usage) {
                  const [row] = await exhaustRunBudgetQuery.run(
                    {
                      runId: lockedRun.id,
                      stepKey: args.stepKey,
                      stepAttemptId: attempt.id,
                      error: self.createBudgetErrorPayload({
                        exhausted: error.exhausted,
                        usage,
                      }),
                    },
                    client
                  )
                  exhaustedRun = mapRun(
                    requireRow(row, "Failed to exhaust workflow budget")
                  )
                }

                void usageRecord
              }

              return {
                outcome: "exhausted_budget" as const,
                run: requireRow(exhaustedRun, "Failed to exhaust workflow budget"),
              }
            }

            const retryPolicy = args.retryPolicy
            const errorTag = args.getErrorTag(error)
            const isNonRetryable =
              errorTag !== null &&
              retryPolicy?.nonRetryableErrorTags?.includes(errorTag) === true
            const canRetry =
              retryPolicy !== undefined &&
              !isNonRetryable &&
              attempt.attempt < retryPolicy.maxAttempts
            const errorPayload = args.asErrorPayload(error)

            if (canRetry) {
              const availableAt = args.resolveRetryAvailableAt({
                attempt: attempt.attempt,
                retryPolicy,
              })
              const [updatedRow] = await retryTransactionalTaskQuery.run(
                {
                  runId: lockedRun.id,
                  stepKey: args.stepKey,
                  workerId: args.workerId,
                  error: errorPayload,
                  availableAt,
                  attemptId: attempt.id,
                },
                client
              )

              if (!updatedRow) {
                return { outcome: "lost_lease" as const, run: null }
              }

              return {
                outcome: "retry_scheduled" as const,
                run: mapRun(updatedRow),
              }
            }

            const [updatedRow] = await failTransactionalTaskQuery.run(
              {
                runId: lockedRun.id,
                stepKey: args.stepKey,
                workerId: args.workerId,
                error: errorPayload,
                attemptId: attempt.id,
              },
              client
            )

            if (!updatedRow) {
              return { outcome: "lost_lease" as const, run: null }
            }

            return {
              outcome: "failed" as const,
              run: mapRun(updatedRow),
            }
          }
        })
        if (outcome.run) {
          await notifyRunEvent(outcome.run.id)

          if (outcome.outcome === "completed") {
            await notifyRunnable()
          }
        }

        return outcome
      }
    )

  return {
    executeTransactionalTask,
  }
}
