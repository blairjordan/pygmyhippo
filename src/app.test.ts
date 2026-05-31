import { afterAll, describe, expect, it } from "vitest"

import { createApp } from "./app.js"
import { createMetrics } from "./lib/metrics.js"
import { createWorkflowEngine } from "./lib/workflow-engine.js"
import { demoWorkflow } from "./workflows/demo.js"

const createStoreStub = (healthy: boolean | Error = true) => ({
  async advanceTaskStep() {
    throw new Error("not used")
  },
  async beginStepAttempt() {
    throw new Error("not used")
  },
  async claimNextRunnableRun() {
    return null
  },
  async completeRun() {
    throw new Error("not used")
  },
  async countOpenWaits() {
    return 0
  },
  async failRun() {
    throw new Error("not used")
  },
  async getRun() {
    return null
  },
  async getRunEvents() {
    return []
  },
  async openWait() {
    throw new Error("not used")
  },
  async ping() {
    if (healthy instanceof Error) {
      throw healthy
    }

    return healthy
  },
  async resumeWait() {
    return { status: "missing" as const, run: null }
  },
  async scheduleRetry() {
    throw new Error("not used")
  },
  async scheduleSleep() {
    throw new Error("not used")
  },
  async startRun() {
    throw new Error("not used")
  },
})

describe("app routes", () => {
  const app = createApp({
    engine: createWorkflowEngine({
      definitions: [demoWorkflow],
      metrics: createMetrics(),
      store: createStoreStub(),
    }),
    metrics: createMetrics(),
    store: createStoreStub(),
  })

  afterAll(async () => {
    await app.close()
  })

  it("returns 404 for an unknown workflow", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/workflows/missing/render",
    })

    expect(response.statusCode).toBe(404)
  })

  it("returns healthz pass when the store can ping", async () => {
    const healthyApp = createApp({
      engine: createWorkflowEngine({
        definitions: [demoWorkflow],
        metrics: createMetrics(),
        store: createStoreStub(true),
      }),
      metrics: createMetrics(),
      store: createStoreStub(true),
    })

    const response = await healthyApp.inject({
      method: "GET",
      url: "/healthz",
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: "pass" })

    await healthyApp.close()
  })

  it("returns healthz fail when the store ping rejects", async () => {
    const failingApp = createApp({
      engine: createWorkflowEngine({
        definitions: [demoWorkflow],
        metrics: createMetrics(),
        store: createStoreStub(new Error("db down")),
      }),
      metrics: createMetrics(),
      store: createStoreStub(new Error("db down")),
    })

    const response = await failingApp.inject({
      method: "GET",
      url: "/healthz",
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: "fail" })

    await failingApp.close()
  })

  it("treats duplicate wait resumes as idempotent success", async () => {
    const duplicateStore = {
      ...createStoreStub(),
      async resumeWait() {
        return {
          status: "duplicate" as const,
          run: {
            id: "run-1",
            definitionName: demoWorkflow.name,
            definitionVersion: demoWorkflow.version,
            status: "queued" as const,
            currentStepKey: "wait-for-webhook",
            input: {},
            context: {},
            result: null,
            error: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            availableAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
            completedAt: null,
          },
        }
      },
    }
    const duplicateApp = createApp({
      engine: createWorkflowEngine({
        definitions: [demoWorkflow],
        metrics: createMetrics(),
        store: duplicateStore,
      }),
      metrics: createMetrics(),
      store: duplicateStore,
    })

    const response = await duplicateApp.inject({
      method: "POST",
      url: "/v1/waits/abc123/resume",
      payload: { payload: { ok: true } },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      outcome: "duplicate",
      runId: "run-1",
      status: "queued",
      currentStepKey: "wait-for-webhook",
    })

    await duplicateApp.close()
  })
})
