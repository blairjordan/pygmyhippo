import type { JsonObject, JsonValue } from "../../types/json.js"
import type {
  ChildStepResult,
  CompensationDefinition,
  CompensationHandler,
  SleepStepDefinition,
  StepExecutionContext,
  StepExecutionKV,
  TaskStepDefinition,
  TaskStepResult,
  WaitStepResumeResult,
  WorkflowRunRecord,
} from "../../types/workflow.js"
import type { HippoMetrics } from "../metrics.js"
import {
  createTraceAttributes,
  type HippoTracer,
} from "../tracing.js"
import {
  BudgetExceededError,
  LostLeaseError,
  type WorkflowStore,
} from "../workflow-store.js"
import {
  requireDefinition,
  getStep,
  type DefinitionRegistry,
} from "./registry.js"
import {
  getRetryAvailableAt,
  createRetryDelayInput,
  getErrorTag,
  defaultCompensationRetryPolicy,
} from "./retry.js"

export const asErrorPayload = (error: unknown): JsonObject => ({
  message: error instanceof Error ? error.message : "Unknown error",
  ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
})

export const mergeContext = (left: JsonObject, right?: JsonObject) => ({
  ...left,
  ...(right ?? {}),
})

export const sleep = (delayMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs)
  })

export const createExecutionContext = (args: {
  run: WorkflowRunRecord & { kv: StepExecutionKV }
  attempt: number
  stepKey: string
  heartbeat: () => Promise<boolean>
  emit: StepExecutionContext["emit"]
  recordUsage: StepExecutionContext["recordUsage"]
  db: StepExecutionContext["db"]
  outbox: StepExecutionContext["outbox"]
  transactional: boolean
  kv: StepExecutionKV
}): StepExecutionContext => ({
  run: args.run,
  input: args.run.input,
  context: args.run.context,
  now: new Date(),
  attempt: args.attempt,
  idempotencyKey: `${args.run.id}:${args.stepKey}`,
  heartbeat: args.heartbeat,
  emit: args.emit,
  recordUsage: args.recordUsage,
  db: args.db,
  outbox: args.outbox,
  transactional: args.transactional,
  kv: args.kv,
})

export const noopEmit: StepExecutionContext["emit"] = async () => {}
export const noopRecordUsage: StepExecutionContext["recordUsage"] = async () => {}

export const createStepInput = (
  run: WorkflowRunRecord,
  stepKey: string
): JsonObject => ({
  workflow: run.definitionName,
  step: stepKey,
  input: run.input,
  context: run.context,
})

export const resolveTaskTransition = (
  result: TaskStepResult,
  fallback: string | undefined
) => result.transition ?? fallback ?? null

export const resolveSleepUntil = (
  step: SleepStepDefinition,
  context: StepExecutionContext
) => {
  const resolved =
    typeof step.until === "function" ? step.until(context) : step.until

  if (resolved instanceof Date) {
    return resolved
  }

  if (typeof resolved === "number") {
    return new Date(context.now.getTime() + resolved)
  }

  return new Date(resolved)
}

export const getStepExpiresAt = (timeoutMs: number, now: Date) =>
  new Date(now.getTime() + timeoutMs)

export const isTerminalStatus = (status: WorkflowRunRecord["status"]) =>
  status === "completed" ||
  status === "failed" ||
  status === "compensation_failed" ||
  status === "exhausted_budget" ||
  status === "canceled"

export const getCompensationDefinition = (
  step: TaskStepDefinition
): CompensationDefinition | null => {
  if (!step.compensate) {
    return null
  }

  if (typeof step.compensate === "function") {
    return {
      run: step.compensate as CompensationHandler,
      retry: defaultCompensationRetryPolicy,
    }
  }

  return {
    ...step.compensate,
    retry: {
      ...defaultCompensationRetryPolicy,
      ...(step.compensate.retry ?? {}),
    },
  }
}

export const observeRunDuration = (args: {
  metrics: HippoMetrics
  run: WorkflowRunRecord
  status: "completed" | "failed"
}) => {
  const durationSeconds =
    (Date.now() - args.run.createdAt.getTime()) / 1_000

  args.metrics.runDurationSeconds.observe(
    {
      workflow: args.run.definitionName,
      status: args.status,
    },
    durationSeconds
  )
}

export const withTimeout = async <T>(
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

export const continueRun = async (args: {
  definitions: DefinitionRegistry
  metrics: HippoMetrics
  store: WorkflowStore
  tracer: HippoTracer
  workerId: string
  run: WorkflowRunRecord
}): Promise<WorkflowRunRecord | null> => {
  let activeRun = args.run
  const definition = requireDefinition(
    args.definitions,
    activeRun.definitionName,
    activeRun.definitionVersion
  )

  while (activeRun.currentStepKey) {
    const stepKey = activeRun.currentStepKey
    const step = getStep(definition, stepKey)
    const stepBindings = {
      db: {
        query: args.store.queryStepDatabase,
      },
      outbox: {
        enqueue: async (input: {
          topic: string
          payload: JsonObject
          availableAt?: Date
        }) => {
          await args.store.enqueueOutbox({
            runId: activeRun.id,
            topic: input.topic,
            payload: input.payload,
            ...(input.availableAt === undefined
              ? {}
              : { availableAt: input.availableAt }),
          })
        },
      },
      kv: {
        get: async (key: string) => {
          return args.store.getRunKV(activeRun.id, key)
        },
        set: async (key: string, value: JsonValue) => {
          await args.store.setRunKV(activeRun.id, key, value)
        },
        delete: async (key: string) => {
          await args.store.deleteRunKV(activeRun.id, key)
        },
      },
    }

    if (
      activeRun.cancelRequestedAt !== null &&
      activeRun.cancelMode === "graceful"
    ) {
      const canceled = await args.store.cancelRunAtBoundary({
        runId: activeRun.id,
        stepKey,
        workerId: args.workerId,
        mode: activeRun.cancelMode,
      })

      return canceled
    }

    if (step.kind === "end") {
      const completed = await args.store.completeRun({
        runId: activeRun.id,
        stepKey,
        workerId: args.workerId,
        context: activeRun.context,
        result: activeRun.context,
      })

      args.metrics.runsCompleted.inc({ workflow: definition.name })
      observeRunDuration({
        metrics: args.metrics,
        run: completed,
        status: "completed",
      })
      return completed
    }

    if (step.kind === "sleep") {
      const availableAt = resolveSleepUntil(
        step,
        createExecutionContext({
          run: {
            ...activeRun,
            kv: stepBindings.kv,
          },
          attempt: 0,
          stepKey,
          heartbeat: async () => false,
          emit: noopEmit,
          recordUsage: noopRecordUsage,
          db: stepBindings.db,
          outbox: stepBindings.outbox,
          transactional: false,
          kv: stepBindings.kv,
        })
      )

      activeRun = await args.store.scheduleSleep({
        runId: activeRun.id,
        stepKey,
        workerId: args.workerId,
        nextStepKey: step.next,
        availableAt,
      })
      return activeRun
    }

    const stepResult = await args.tracer.withSpan(
      {
        name: "hippo.workflow.step.execute",
        attributes: createTraceAttributes({
          operation: "workflow.step.execute",
          workflowName: activeRun.definitionName,
          workflowVersion: activeRun.definitionVersion,
          runId: activeRun.id,
          stepKey,
          stepKind: step.kind,
          taskQueue: activeRun.taskQueue,
          workerId: args.workerId,
        }),
      },
      async () => {
        const attempt = await args.store.beginStepAttempt({
          runId: activeRun.id,
          stepKey,
          input: createStepInput(activeRun, stepKey),
        })
        const executionContext = createExecutionContext({
          run: {
            ...activeRun,
            kv: stepBindings.kv,
          },
          attempt: attempt.attempt,
          stepKey,
          heartbeat: () =>
            args.store.extendLease({
              runId: activeRun.id,
              stepKey,
              attemptId: attempt.id,
              workerId: args.workerId,
              leaseMs: 15_000,
            }),
          emit: async (event) => {
            await args.store.emitStepEvent({
              runId: activeRun.id,
              stepKey,
              stepAttemptId: attempt.id,
              type: event.type,
              data: event.data,
            })
          },
          recordUsage: async (usage) => {
            await args.store.recordUsage({
              runId: activeRun.id,
              stepKey,
              stepAttemptId: attempt.id,
              usage,
              ...(definition.budget === undefined
                ? {}
                : { budget: definition.budget }),
            })
          },
          db: stepBindings.db,
          outbox: stepBindings.outbox,
          transactional: false,
          kv: stepBindings.kv,
        })

        try {
          if (step.kind === "wait") {
            const waitResult = await args.tracer.withSpan(
              {
                name: "hippo.workflow.step.wait.open",
                attributes: createTraceAttributes({
                  operation: "workflow.step.wait.open",
                  workflowName: activeRun.definitionName,
                  workflowVersion: activeRun.definitionVersion,
                  runId: activeRun.id,
                  stepKey,
                  stepKind: step.kind,
                  taskQueue: activeRun.taskQueue,
                  workerId: args.workerId,
                }),
              },
              () => Promise.resolve(step.open(executionContext))
            )
            activeRun = await args.store.openWait({
              runId: activeRun.id,
              stepKey,
              workerId: args.workerId,
              attemptId: attempt.id,
              context: activeRun.context,
              correlationKey: waitResult.correlationKey,
              payload: waitResult.payload ?? null,
              expiresAt: getStepExpiresAt(step.timeoutMs, executionContext.now),
              output: waitResult.payload ?? null,
            })

            args.metrics.stepAttempts.inc({
              workflow: definition.name,
              step: stepKey,
              status: "completed",
            })
            args.metrics.waitOpens.set(await args.store.countOpenWaits())
            return activeRun
          }

          if (step.kind === "signal") {
            const consumeSignal = () =>
              args.store.consumeSignal({
                runId: activeRun.id,
                signalName: step.signal,
              })

            const signal = await consumeSignal()
            const resumeSignal = async (input: {
              run: WorkflowRunRecord
              payload: JsonValue | undefined
              attempt: number
            }) => {
              const signalExecutionContext = createExecutionContext({
                run: {
                  ...input.run,
                  kv: stepBindings.kv,
                },
                attempt: input.attempt,
                stepKey,
                heartbeat: async () => false,
                emit: noopEmit,
                recordUsage: noopRecordUsage,
                db: stepBindings.db,
                outbox: stepBindings.outbox,
                transactional: false,
                kv: stepBindings.kv,
              })
              const result: WaitStepResumeResult = await args.tracer.withSpan(
                {
                  name: "hippo.workflow.step.signal.resume",
                  attributes: createTraceAttributes({
                    operation: "workflow.step.signal.resume",
                    workflowName: input.run.definitionName,
                    workflowVersion: input.run.definitionVersion,
                    runId: input.run.id,
                    stepKey,
                    stepKind: step.kind,
                    taskQueue: input.run.taskQueue,
                  }),
                },
                () => Promise.resolve(step.resume(signalExecutionContext, input.payload))
              )
              const nextStepKey = result.transition ?? step.next

              if (!nextStepKey) {
                throw new Error(
                  `Signal step "${stepKey}" in workflow "${definition.name}" did not resolve a next step`
                )
              }

              return {
                nextStepKey,
                context: mergeContext(activeRun.context, result.patch),
                output: result.output ?? null,
              }
            }

            if (!signal) {
              activeRun = await args.store.openWait({
                runId: activeRun.id,
                stepKey,
                workerId: args.workerId,
                attemptId: attempt.id,
                context: activeRun.context,
                correlationKey: `signal:${activeRun.id}:${step.signal}`,
                payload: {
                  signalName: step.signal,
                },
                expiresAt: getStepExpiresAt(step.timeoutMs, executionContext.now),
                output: null,
              })

              const resumed = await args.store.consumeSignalAndResumeWait({
                correlationKey: `signal:${activeRun.id}:${step.signal}`,
                signalName: step.signal,
                resume: async (signalPayload) =>
                  resumeSignal({
                    run: activeRun,
                    payload: signalPayload,
                    attempt: 0,
                  }),
              })

              args.metrics.waitOpens.set(await args.store.countOpenWaits())

              if (resumed.status === "resumed" && resumed.run) {
                return resumed.run
              }

              return activeRun
            }

            const result = await resumeSignal({
              run: activeRun,
              payload: signal.payload ?? undefined,
              attempt: attempt.attempt,
            })
            activeRun = await args.store.advanceTaskStep({
              runId: activeRun.id,
              stepKey,
              workerId: args.workerId,
              attemptId: attempt.id,
              nextStepKey: result.nextStepKey,
              context: result.context,
              output: result.output,
            })

            args.metrics.stepAttempts.inc({
              workflow: definition.name,
              step: stepKey,
              status: "completed",
            })
            args.metrics.waitOpens.set(await args.store.countOpenWaits())
            return activeRun
          }

          if (step.kind === "child") {
            const childRun = await args.store.getChildRun({
              parentRunId: activeRun.id,
              parentStepKey: stepKey,
            })

            const resumeChild = async (run: WorkflowRunRecord) => {
              const childExecutionContext = createExecutionContext({
                run: {
                  ...activeRun,
                  kv: stepBindings.kv,
                },
                attempt: attempt.attempt,
                stepKey,
                heartbeat: async () => false,
                emit: async (event) => {
                  await args.store.emitStepEvent({
                    runId: activeRun.id,
                    stepKey,
                    stepAttemptId: attempt.id,
                    type: event.type,
                    data: event.data,
                  })
                },
                recordUsage: async (usage) => {
                  await args.store.recordUsage({
                    runId: activeRun.id,
                    stepKey,
                    stepAttemptId: attempt.id,
                    usage,
                    ...(definition.budget === undefined
                      ? {}
                      : { budget: definition.budget }),
                  })
                },
                db: stepBindings.db,
                outbox: stepBindings.outbox,
                transactional: false,
                kv: stepBindings.kv,
              })
              const result: ChildStepResult = await args.tracer.withSpan(
                {
                  name: "hippo.workflow.step.child.resume",
                  attributes: createTraceAttributes({
                    operation: "workflow.step.child.resume",
                    workflowName: activeRun.definitionName,
                    workflowVersion: activeRun.definitionVersion,
                    runId: activeRun.id,
                    stepKey,
                    stepKind: step.kind,
                    taskQueue: activeRun.taskQueue,
                    workerId: args.workerId,
                  }),
                },
                () => Promise.resolve(step.resume(childExecutionContext, run))
              )
              const nextStepKey = result.transition ?? step.next

              if (!nextStepKey) {
                throw new Error(
                  `Child step "${stepKey}" in workflow "${definition.name}" did not resolve a next step`
                )
              }

              return {
                nextStepKey,
                context: mergeContext(activeRun.context, result.patch),
                output: result.output ?? run.result ?? null,
              }
            }

            if (childRun && isTerminalStatus(childRun.status)) {
              const result = await resumeChild(childRun)
              activeRun = await args.store.advanceTaskStep({
                runId: activeRun.id,
                stepKey,
                workerId: args.workerId,
                attemptId: attempt.id,
                nextStepKey: result.nextStepKey,
                context: result.context,
                output: result.output,
              })

              args.metrics.stepAttempts.inc({
                workflow: definition.name,
                step: stepKey,
                status: "completed",
              })
              return activeRun
            }

            if (!childRun) {
              const childInput = await args.tracer.withSpan(
                {
                  name: "hippo.workflow.step.child.input",
                  attributes: createTraceAttributes({
                    operation: "workflow.step.child.input",
                    workflowName: activeRun.definitionName,
                    workflowVersion: activeRun.definitionVersion,
                    runId: activeRun.id,
                    stepKey,
                    stepKind: step.kind,
                    taskQueue: activeRun.taskQueue,
                    workerId: args.workerId,
                  }),
                },
                () => Promise.resolve(step.input(executionContext))
              )
              await args.store.startRun({
                parentRunId: activeRun.id,
                parentStepKey: stepKey,
                definitionName: step.workflow,
                definitionVersion: requireDefinition(args.definitions, step.workflow)
                  .version,
                taskQueue: activeRun.taskQueue,
                priority: activeRun.priority,
                input: childInput,
                currentStepKey: requireDefinition(args.definitions, step.workflow)
                  .startAt,
              })
            }

            activeRun = await args.store.openWait({
              runId: activeRun.id,
              stepKey,
              workerId: args.workerId,
              attemptId: attempt.id,
              context: activeRun.context,
              correlationKey: `child:${activeRun.id}:${stepKey}`,
              payload: {
                workflowName: step.workflow,
              },
              expiresAt: null,
              output: null,
            })
            args.metrics.stepAttempts.inc({
              workflow: definition.name,
              step: stepKey,
              status: "completed",
            })
            args.metrics.waitOpens.set(await args.store.countOpenWaits())
            return activeRun
          }

          if (step.kind === "externalSession") {
            const sessionResult = await args.tracer.withSpan(
              {
                name: "hippo.workflow.step.external_session.start",
                attributes: createTraceAttributes({
                  operation: "workflow.step.external_session.start",
                  workflowName: activeRun.definitionName,
                  workflowVersion: activeRun.definitionVersion,
                  runId: activeRun.id,
                  stepKey,
                  stepKind: step.kind,
                  taskQueue: activeRun.taskQueue,
                  workerId: args.workerId,
                }),
              },
              () =>
                withTimeout(
                  Promise.resolve(step.start(executionContext)),
                  step.timeoutMs,
                  `External session step "${stepKey}" in workflow "${definition.name}"`
                )
            )

            activeRun = await args.store.openWait({
              runId: activeRun.id,
              stepKey,
              workerId: args.workerId,
              attemptId: attempt.id,
              context: activeRun.context,
              correlationKey: `external:${sessionResult.externalId}`,
              payload: sessionResult.payload ?? null,
              expiresAt: getStepExpiresAt(step.timeoutMs, executionContext.now),
              output: sessionResult.payload ?? null,
              externalSessionId: sessionResult.externalId,
              externalSessionKind: step.sessionKind,
            })

            args.metrics.stepAttempts.inc({
              workflow: definition.name,
              step: stepKey,
              status: "completed",
            })
            args.metrics.waitOpens.set(await args.store.countOpenWaits())
            return activeRun
          }

          if (step.kind !== "task") {
            throw new Error("Encountered an unsupported executable step kind")
          }

          if (step.transactional) {
            const outcome = await args.store.executeTransactionalTask({
              run: activeRun,
              stepKey,
              workerId: args.workerId,
              ...(step.next === undefined ? {} : { nextStepKey: step.next }),
              ...(step.retry === undefined ? {} : { retryPolicy: step.retry }),
              ...(definition.budget === undefined ? {} : { budget: definition.budget }),
              ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
              resolveRetryAvailableAt: ({ attempt, retryPolicy }) =>
                getRetryAvailableAt({
                  attempt,
                  ...createRetryDelayInput(retryPolicy),
                }),
              getErrorTag,
              asErrorPayload,
              mergeContext,
              runTask: step.run,
            })

            if (outcome.outcome === "lost_lease") {
              return null
            }

            if (!outcome.run) {
              return null
            }

            activeRun = outcome.run

            if (outcome.outcome === "completed") {
              args.metrics.stepAttempts.inc({
                workflow: definition.name,
                step: stepKey,
                status: "completed",
              })
            } else if (outcome.outcome === "exhausted_budget") {
              args.metrics.stepAttempts.inc({
                workflow: definition.name,
                step: stepKey,
                status: "failed",
              })
              args.metrics.runsFailed.inc({
                workflow: definition.name,
                step: stepKey,
              })
              observeRunDuration({
                metrics: args.metrics,
                run: activeRun,
                status: "failed",
              })
              return activeRun
            } else {
              args.metrics.stepAttempts.inc({
                workflow: definition.name,
                step: stepKey,
                status: "failed",
              })
              if (outcome.outcome === "retry_scheduled") {
                args.metrics.retries.inc({
                  workflow: definition.name,
                  step: stepKey,
                })
              } else {
                args.metrics.runsFailed.inc({
                  workflow: definition.name,
                  step: stepKey,
                })
                observeRunDuration({
                  metrics: args.metrics,
                  run: activeRun,
                  status: "failed",
                })
                activeRun = await compensateRun({
                  definitions: args.definitions,
                  metrics: args.metrics,
                  store: args.store,
                  tracer: args.tracer,
                  run: activeRun,
                })
              }
            }

            return activeRun
          }

          const result = await args.tracer.withSpan(
            {
              name: "hippo.workflow.step.task.run",
              attributes: createTraceAttributes({
                operation: "workflow.step.task.run",
                workflowName: activeRun.definitionName,
                workflowVersion: activeRun.definitionVersion,
                runId: activeRun.id,
                stepKey,
                stepKind: step.kind,
                taskQueue: activeRun.taskQueue,
                workerId: args.workerId,
              }),
            },
            () =>
              withTimeout(
                Promise.resolve(step.run(executionContext)),
                step.timeoutMs,
                `Task step "${stepKey}" in workflow "${definition.name}"`
              )
          )

          if (result.continueAsNew) {
            const nextRun = await args.store.continueAsNew({
              runId: activeRun.id,
              stepKey,
              workerId: args.workerId,
              attemptId: attempt.id,
              context: mergeContext(activeRun.context, result.patch),
              currentStepKey: definition.startAt,
              input: result.continueAsNew.payload,
              taskQueue: result.continueAsNew.taskQueue ?? activeRun.taskQueue,
              priority: result.continueAsNew.priority ?? activeRun.priority,
            })

            args.metrics.runsStarted.inc({ workflow: definition.name })
            observeRunDuration({
              metrics: args.metrics,
              run: activeRun,
              status: "completed",
            })
            args.metrics.stepAttempts.inc({
              workflow: definition.name,
              step: stepKey,
              status: "completed",
            })
            return nextRun
          }

          const nextStepKey = resolveTaskTransition(result, step.next)

          if (!nextStepKey) {
            throw new Error(
              `Task step "${stepKey}" in workflow "${definition.name}" did not resolve a next step`
            )
          }

          activeRun = await args.store.advanceTaskStep({
            runId: activeRun.id,
            stepKey,
            workerId: args.workerId,
            attemptId: attempt.id,
            nextStepKey,
            context: mergeContext(activeRun.context, result.patch),
            output: result.output ?? null,
          })

          args.metrics.stepAttempts.inc({
            workflow: definition.name,
            step: stepKey,
            status: "completed",
          })
          return activeRun
        } catch (error) {
          if (error instanceof LostLeaseError) {
            return null
          }

          if (error instanceof BudgetExceededError) {
            activeRun = error.run
            args.metrics.stepAttempts.inc({
              workflow: definition.name,
              step: stepKey,
              status: "failed",
            })
            args.metrics.runsFailed.inc({
              workflow: definition.name,
              step: stepKey,
            })
            observeRunDuration({
              metrics: args.metrics,
              run: activeRun,
              status: "failed",
            })
            return activeRun
          }

          const retryPolicy =
            step.kind === "task" || step.kind === "externalSession"
              ? step.retry
              : undefined
          const errorTag = getErrorTag(error)
          const isNonRetryable =
            errorTag !== null &&
            retryPolicy?.nonRetryableErrorTags?.includes(errorTag) === true
          const canRetry =
            retryPolicy !== undefined &&
            !isNonRetryable &&
            attempt.attempt < retryPolicy.maxAttempts

          if (canRetry) {
            activeRun = await args.store.scheduleRetry({
              runId: activeRun.id,
              stepKey,
              workerId: args.workerId,
              attemptId: attempt.id,
              availableAt: getRetryAvailableAt({
                attempt: attempt.attempt,
                ...createRetryDelayInput(retryPolicy),
              }),
              error: asErrorPayload(error),
            })
            args.metrics.retries.inc({
              workflow: definition.name,
              step: stepKey,
            })
          } else {
            activeRun = await args.store.failRun({
              runId: activeRun.id,
              stepKey,
              workerId: args.workerId,
              attemptId: attempt.id,
              error: asErrorPayload(error),
            })

            args.metrics.runsFailed.inc({
              workflow: definition.name,
              step: stepKey,
            })
            observeRunDuration({
              metrics: args.metrics,
              run: activeRun,
              status: "failed",
            })
            activeRun = await compensateRun({
              definitions: args.definitions,
              metrics: args.metrics,
              store: args.store,
              tracer: args.tracer,
              run: activeRun,
            })
          }

          args.metrics.stepAttempts.inc({
            workflow: definition.name,
            step: stepKey,
            status: "failed",
          })
          return activeRun
        }
      }
    )

    if (stepResult === null) {
      return null
    }

    return stepResult
  }

  return activeRun
}

export const compensateRun = async (args: {
  definitions: DefinitionRegistry
  metrics: HippoMetrics
  store: WorkflowStore
  tracer: HippoTracer
  run: WorkflowRunRecord
}): Promise<WorkflowRunRecord> => {
  if (args.run.status !== "failed" && args.run.status !== "canceled") {
    return args.run
  }

  const definition = requireDefinition(
    args.definitions,
    args.run.definitionName,
    args.run.definitionVersion
  )
  const attempts = await args.store.getRunAttempts(args.run.id)
  const compensatedStepKeys = new Set(
    attempts
      .filter(
        (attempt) =>
          attempt.kind === "compensate" && attempt.status === "completed"
      )
      .map((attempt) => attempt.stepKey)
  )
  const compensatableSteps = [...attempts]
    .reverse()
    .flatMap((attempt) => {
      if (
        attempt.kind !== "forward" ||
        attempt.status !== "completed" ||
        compensatedStepKeys.has(attempt.stepKey)
      ) {
        return []
      }

      const step = definition.steps[attempt.stepKey]

      if (!step || step.kind !== "task") {
        return []
      }

      const compensation = getCompensationDefinition(step)

      if (!compensation) {
        return []
      }

      compensatedStepKeys.add(attempt.stepKey)

      return [
        {
          stepKey: attempt.stepKey,
          compensation,
        },
      ]
    })
  let activeRun = args.run

  for (const item of compensatableSteps) {
    const cause =
      activeRun.error ??
      ({
        status: activeRun.status,
        ...(activeRun.cancelMode === null ? {} : { mode: activeRun.cancelMode }),
      } satisfies JsonObject)

    for (;;) {
      const kv: StepExecutionKV = {
        get: async (key: string) => {
          return args.store.getRunKV(activeRun.id, key)
        },
        set: async (key: string, value: JsonValue) => {
          await args.store.setRunKV(activeRun.id, key, value)
        },
        delete: async (key: string) => {
          await args.store.deleteRunKV(activeRun.id, key)
        },
      }
      const compensationAttempt = await args.store.beginStepAttempt({
        runId: activeRun.id,
        stepKey: item.stepKey,
        kind: "compensate",
        input: {
          workflow: activeRun.definitionName,
          step: item.stepKey,
          mode: "compensate",
          context: activeRun.context,
          cause,
        },
      })

      try {
        await args.tracer.withSpan(
          {
            name: "hippo.workflow.compensation.run",
            attributes: createTraceAttributes({
              operation: "workflow.compensation.run",
              workflowName: activeRun.definitionName,
              workflowVersion: activeRun.definitionVersion,
              runId: activeRun.id,
              stepKey: item.stepKey,
              stepKind: "compensate",
              taskQueue: activeRun.taskQueue,
            }),
          },
          () =>
            Promise.resolve(
              item.compensation.run(
                createExecutionContext({
                  run: {
                    ...activeRun,
                    kv,
                  },
                  attempt: compensationAttempt.attempt,
                  stepKey: item.stepKey,
                  heartbeat: async () => false,
                  emit: async (event) => {
                    await args.store.emitStepEvent({
                      runId: activeRun.id,
                      stepKey: item.stepKey,
                      stepAttemptId: compensationAttempt.id,
                      type: event.type,
                      data: event.data,
                    })
                  },
                  recordUsage: async (usage) => {
                    await args.store.recordUsage({
                      runId: activeRun.id,
                      stepKey: item.stepKey,
                      stepAttemptId: compensationAttempt.id,
                      usage,
                      ...(definition.budget === undefined
                        ? {}
                        : { budget: definition.budget }),
                    })
                  },
                  db: {
                    query: args.store.queryStepDatabase,
                  },
                  outbox: {
                    enqueue: async (input) => {
                      await args.store.enqueueOutbox({
                        runId: activeRun.id,
                        topic: input.topic,
                        payload: input.payload,
                        ...(input.availableAt === undefined
                          ? {}
                          : { availableAt: input.availableAt }),
                      })
                    },
                  },
                  transactional: false,
                  kv,
                }),
                cause
              )
            )
        )
        await args.store.completeStepAttempt({
          runId: activeRun.id,
          stepKey: item.stepKey,
          attemptId: compensationAttempt.id,
          output: {
            status: "compensated",
          },
        })
        break
      } catch (error) {
        await args.store.failStepAttempt({
          runId: activeRun.id,
          stepKey: item.stepKey,
          attemptId: compensationAttempt.id,
          error: asErrorPayload(error),
        })

        const retryPolicy =
          item.compensation.retry ?? defaultCompensationRetryPolicy
        const canRetry = compensationAttempt.attempt < retryPolicy.maxAttempts

        if (!canRetry) {
          activeRun = await args.store.markRunCompensationFailed({
            runId: activeRun.id,
            stepKey: item.stepKey,
            error: asErrorPayload(error),
          })
          return activeRun
        }

        const retryAvailableAt = getRetryAvailableAt({
          attempt: compensationAttempt.attempt,
          ...createRetryDelayInput(retryPolicy),
        })

        await sleep(Math.max(0, retryAvailableAt.getTime() - Date.now()))
      }
    }
  }

  return (await args.store.getRun(activeRun.id)) ?? activeRun
}
