import { describe, expect, it } from "vitest"

import { defineWorkflow, endStep, taskStep } from "./workflow-definition.js"
import { createMetrics } from "./metrics.js"
import { createWorkflowEngine } from "./workflow-engine.js"
import type { JsonObject, JsonValue } from "../types/json.js"
import type {
  WorkflowEventRecord,
  WorkflowRunRecord,
  WorkflowStepAttemptRecord,
  WorkflowWaitRecord,
} from "../types/workflow.js"

const createStoreStub = () => {
  const runs = new Map<string, WorkflowRunRecord>()
  const events: WorkflowEventRecord[] = []
  const attempts: WorkflowStepAttemptRecord[] = []
  let runCounter = 0
  let attemptCounter = 0
  let eventCounter = 0

  const now = () => new Date()

  return {
    async claimNextRunnableRun() {
      const run = [...runs.values()].find(
        (candidate) =>
          (candidate.status === "queued" || candidate.status === "running") &&
          candidate.currentStepKey !== null
      )

      if (!run) {
        return null
      }

      const claimed = {
        ...run,
        status: "running" as const,
      }

      runs.set(run.id, claimed)
      return claimed
    },
    async completeAttempt(args: {
      attemptId: string
      output: JsonValue | null
      status: "completed" | "failed"
      error: JsonValue | null
    }) {
      const index = attempts.findIndex((attempt) => attempt.id === args.attemptId)
      const next = {
        ...attempts[index]!,
        status: args.status,
        output: args.output,
        error: args.error,
        completedAt: now(),
      }
      attempts[index] = next
      return next
    },
    async countOpenWaits() {
      return 0
    },
    async getOpenWaitByCorrelationKey() {
      return null as WorkflowWaitRecord | null
    },
    async getRun(runId: string) {
      return runs.get(runId) ?? null
    },
    async getRunEvents(runId: string) {
      return events.filter((event) => event.runId === runId)
    },
    async insertAttempt(args: {
      runId: string
      stepKey: string
      input: JsonObject
    }) {
      attemptCounter += 1
      const attempt: WorkflowStepAttemptRecord = {
        id: `attempt-${attemptCounter}`,
        runId: args.runId,
        stepKey: args.stepKey,
        attempt: attempts.filter(
          (candidate) =>
            candidate.runId === args.runId && candidate.stepKey === args.stepKey
        ).length + 1,
        status: "started",
        input: args.input,
        output: null,
        error: null,
        startedAt: now(),
        completedAt: null,
        createdAt: now(),
        updatedAt: now(),
      }
      attempts.push(attempt)
      return attempt
    },
    async insertEvent(args: {
      runId: string
      stepKey: string | null
      eventType: string
      payload?: JsonObject
    }) {
      eventCounter += 1
      const event: WorkflowEventRecord = {
        id: eventCounter,
        runId: args.runId,
        stepKey: args.stepKey,
        eventType: args.eventType,
        payload: args.payload ?? {},
        createdAt: now(),
      }
      events.push(event)
      return event
    },
    async insertRun(args: {
      definitionName: string
      definitionVersion: number
      input: JsonObject
      currentStepKey: string
    }) {
      runCounter += 1
      const run: WorkflowRunRecord = {
        id: `run-${runCounter}`,
        definitionName: args.definitionName,
        definitionVersion: args.definitionVersion,
        status: "queued",
        currentStepKey: args.currentStepKey,
        input: args.input,
        context: {},
        result: null,
        error: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: now(),
        updatedAt: now(),
        completedAt: null,
      }
      runs.set(run.id, run)
      return run
    },
    async insertWait() {
      throw new Error("Not implemented in test store")
    },
    async markRunCompleted(args: {
      runId: string
      context: JsonObject
      result: JsonValue | null
    }) {
      const run = runs.get(args.runId)!
      const next: WorkflowRunRecord = {
        ...run,
        status: "completed",
        currentStepKey: null,
        context: args.context,
        result: args.result,
        completedAt: now(),
      }
      runs.set(run.id, next)
      return next
    },
    async markRunFailed(args: { runId: string; error: JsonValue }) {
      const run = runs.get(args.runId)!
      const next: WorkflowRunRecord = {
        ...run,
        status: "failed",
        error: args.error,
        completedAt: now(),
      }
      runs.set(run.id, next)
      return next
    },
    async markRunWaiting() {
      throw new Error("Not implemented in test store")
    },
    async markWaitResumed() {
      throw new Error("Not implemented in test store")
    },
    async updateRunForNextStep(args: {
      runId: string
      context: JsonObject
      nextStepKey: string
    }) {
      const run = runs.get(args.runId)!
      const next: WorkflowRunRecord = {
        ...run,
        status: "queued",
        currentStepKey: args.nextStepKey,
        context: args.context,
      }
      runs.set(run.id, next)
      return next
    },
  }
}

describe("workflow engine", () => {
  it("runs a task workflow to completion", async () => {
    const workflow = defineWorkflow({
      name: "test-workflow",
      version: 1,
      startAt: "start",
      steps: {
        start: taskStep({
          kind: "task",
          next: "done",
          run: () => ({
            patch: { delivered: true },
          }),
        }),
        done: endStep(),
      },
    })
    const store = createStoreStub()
    const engine = createWorkflowEngine({
      definitions: [workflow],
      metrics: createMetrics(),
      store,
    })

    const run = await engine.startRun({
      workflowName: "test-workflow",
      payload: { hello: "world" },
    })

    await engine.tick("test-worker", 5_000)
    const completed = await store.getRun(run.id)

    expect(completed?.status).toBe("completed")
    expect(completed?.context).toEqual({ delivered: true })
  })
})
