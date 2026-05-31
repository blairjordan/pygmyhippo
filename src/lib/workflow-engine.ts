import type { JsonObject, JsonValue } from "../types/json.js"
import type {
  StepExecutionContext,
  TaskStepResult,
  WaitStepResumeResult,
  WorkflowDefinition,
  WorkflowRunRecord,
} from "../types/workflow.js"
import type { HippoMetrics } from "./metrics.js"
import type { WorkflowStore } from "./workflow-store.js"

const asErrorPayload = (error: unknown): JsonObject => ({
  message: error instanceof Error ? error.message : "Unknown error",
  ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
})

const mergeContext = (left: JsonObject, right?: JsonObject) => ({
  ...left,
  ...(right ?? {}),
})

const getDefinition = (
  definitions: Map<string, WorkflowDefinition>,
  name: string
) => {
  const definition = definitions.get(name)

  if (!definition) {
    throw new Error(`Workflow definition "${name}" is not registered`)
  }

  return definition
}

const getStep = (definition: WorkflowDefinition, stepKey: string) => {
  const step = definition.steps[stepKey]

  if (!step) {
    throw new Error(
      `Workflow "${definition.name}" is missing step "${stepKey}"`
    )
  }

  return step
}

const createExecutionContext = (
  run: WorkflowRunRecord
): StepExecutionContext => ({
  run,
  input: run.input,
  context: run.context,
  now: new Date(),
})

const createStepInput = (
  run: WorkflowRunRecord,
  stepKey: string
): JsonObject => ({
  workflow: run.definitionName,
  step: stepKey,
  input: run.input,
  context: run.context,
})

const continueRun = async (args: {
  definitions: Map<string, WorkflowDefinition>
  metrics: HippoMetrics
  store: WorkflowStore
  run: WorkflowRunRecord
}) => {
  let activeRun = args.run
  const definition = getDefinition(args.definitions, activeRun.definitionName)

  while (activeRun.currentStepKey) {
    const stepKey = activeRun.currentStepKey
    const step = getStep(definition, stepKey)

    if (step.kind === "end") {
      const completed = await args.store.markRunCompleted({
        runId: activeRun.id,
        context: activeRun.context,
        result: activeRun.context,
      })

      args.metrics.runsCompleted.inc({ workflow: definition.name })
      await args.store.insertEvent({
        runId: completed.id,
        stepKey,
        eventType: "run.completed",
      })

      return completed
    }

    const attempt = await args.store.insertAttempt({
      runId: activeRun.id,
      stepKey,
      input: createStepInput(activeRun, stepKey),
    })

    try {
      if (step.kind === "wait") {
        const waitResult = await step.open(createExecutionContext(activeRun))
        await args.store.insertWait({
          runId: activeRun.id,
          stepKey,
          correlationKey: waitResult.correlationKey,
          payload: waitResult.payload ?? null,
        })

        await args.store.completeAttempt({
          attemptId: attempt.id,
          output: waitResult.payload ?? null,
          status: "completed",
          error: null,
        })

        args.metrics.stepAttempts.inc({
          workflow: definition.name,
          step: stepKey,
          status: "completed",
        })

        activeRun = await args.store.markRunWaiting({
          runId: activeRun.id,
          context: activeRun.context,
          stepKey,
        })

        await args.store.insertEvent({
          runId: activeRun.id,
          stepKey,
          eventType: "wait.opened",
          payload: {
            correlationKey: waitResult.correlationKey,
          },
        })

        args.metrics.waitOpens.set(await args.store.countOpenWaits())
        return activeRun
      }

      const result = await step.run(createExecutionContext(activeRun))
      const nextStepKey = result.transition ?? step.next
      const nextContext = mergeContext(activeRun.context, result.patch)

      await args.store.completeAttempt({
        attemptId: attempt.id,
        output: result.output ?? null,
        status: "completed",
        error: null,
      })

      args.metrics.stepAttempts.inc({
        workflow: definition.name,
        step: stepKey,
        status: "completed",
      })

      if (!nextStepKey) {
        throw new Error(
          `Task step "${stepKey}" in workflow "${definition.name}" did not resolve a next step`
        )
      }

      activeRun = await args.store.updateRunForNextStep({
        runId: activeRun.id,
        context: nextContext,
        nextStepKey,
      })

      await args.store.insertEvent({
        runId: activeRun.id,
        stepKey,
        eventType: "step.completed",
        payload: {
          nextStepKey,
        },
      })
    } catch (error) {
      await args.store.completeAttempt({
        attemptId: attempt.id,
        output: null,
        status: "failed",
        error: asErrorPayload(error),
      })

      const failedRun = await args.store.markRunFailed({
        runId: activeRun.id,
        error: asErrorPayload(error),
      })

      args.metrics.stepAttempts.inc({
        workflow: definition.name,
        step: stepKey,
        status: "failed",
      })
      args.metrics.runsFailed.inc({
        workflow: definition.name,
        step: stepKey,
      })

      await args.store.insertEvent({
        runId: failedRun.id,
        stepKey,
        eventType: "step.failed",
        payload: asErrorPayload(error),
      })

      return failedRun
    }
  }

  return activeRun
}

export const createWorkflowEngine = (args: {
  definitions: WorkflowDefinition[]
  metrics: HippoMetrics
  store: WorkflowStore
}) => {
  const definitions = new Map(
    args.definitions.map((definition) => [definition.name, definition])
  )

  const startRun = async (input: {
    workflowName: string
    payload: JsonObject
  }) => {
    const definition = getDefinition(definitions, input.workflowName)

    const run = await args.store.insertRun({
      definitionName: definition.name,
      definitionVersion: definition.version,
      input: input.payload,
      currentStepKey: definition.startAt,
    })

    args.metrics.runsStarted.inc({ workflow: definition.name })
    await args.store.insertEvent({
      runId: run.id,
      stepKey: definition.startAt,
      eventType: "run.started",
    })

    return run
  }

  const tick = async (workerId: string, leaseMs: number) => {
    const claimedRun = await args.store.claimNextRunnableRun({ workerId, leaseMs })

    if (!claimedRun) {
      return null
    }

    args.metrics.claims.inc()
    return continueRun({
      definitions,
      metrics: args.metrics,
      store: args.store,
      run: claimedRun,
    })
  }

  const resumeWait = async (input: {
    correlationKey: string
    payload?: JsonValue
  }) => {
    const wait = await args.store.getOpenWaitByCorrelationKey(input.correlationKey)

    if (!wait) {
      return null
    }

    const run = await args.store.getRun(wait.runId)

    if (!run) {
      throw new Error(`Run "${wait.runId}" not found for wait "${wait.id}"`)
    }

    const definition = getDefinition(definitions, run.definitionName)
    const step = getStep(definition, wait.stepKey)

    if (step.kind !== "wait") {
      throw new Error(
        `Step "${wait.stepKey}" in workflow "${definition.name}" is not resumable`
      )
    }

    const result: WaitStepResumeResult = await step.resume(
      createExecutionContext(run),
      input.payload
    )

    const nextStepKey = result.transition ?? step.next

    if (!nextStepKey) {
      throw new Error(
        `Wait step "${wait.stepKey}" in workflow "${definition.name}" did not resolve a next step`
      )
    }

    await args.store.markWaitResumed(wait.id)

    const resumedRun = await args.store.updateRunForNextStep({
      runId: run.id,
      context: mergeContext(run.context, result.patch),
      nextStepKey,
    })

    await args.store.insertEvent({
      runId: run.id,
      stepKey: wait.stepKey,
      eventType: "wait.resumed",
      payload: {
        nextStepKey,
      },
    })

    args.metrics.waitOpens.set(await args.store.countOpenWaits())

    return resumedRun
  }

  const getWorkflow = (workflowName: string) => getDefinition(definitions, workflowName)

  return {
    getWorkflow,
    resumeWait,
    startRun,
    tick,
  }
}

export type WorkflowEngine = ReturnType<typeof createWorkflowEngine>
