import { context, propagation, trace } from "@opentelemetry/api"
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import { beforeAll, describe, expect, it } from "vitest"

import { createMetrics } from "../lib/metrics.js"
import { createWorkflowEngine } from "../lib/workflow-engine.js"
import { createStoreStub } from "../lib/workflow-engine.test-helpers.js"
import { defineWorkflow, endStep } from "../lib/workflow-definition.js"
import { withTraceContext } from "../lib/tracing.js"
import { hermesTurn } from "./hermes.js"

const makeRunner = (requests: Array<{ url: string; body: Record<string, unknown> }>) => ({
  url: "http://runner.test/",
  token: "test-token",
  fetch: async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    })
    return new Response("{}", { status: 202 })
  },
})

describe("Hermes external-session integration", () => {
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncHooksContextManager().enable())
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    trace.setGlobalTracerProvider(new BasicTracerProvider())
  })

  it("propagates trace context, resumes exactly once, and returns JSON-safe output", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const workflow = defineWorkflow({
      name: "hermes-e2e",
      version: 1,
      startAt: "agent",
      steps: {
        agent: hermesTurn({
          runner: makeRunner(requests),
          prompt: ({ input }) => `Reply about ${String(input.topic)}`,
        }),
        done: endStep(),
        "turn-failed": endStep(),
      },
    })
    const store = createStoreStub()
    const engine = createWorkflowEngine({ definitions: [workflow], metrics: createMetrics(), store })
    const run = await withTraceContext(
      "00-11111111111111111111111111111111-2222222222222222-01",
      () => engine.startRun({ workflowName: workflow.name, payload: { topic: "traces" } })
    )

    await engine.tick("test-worker", 5_000)
    const savedRun = await store.getRun(run.id)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: "http://runner.test/turns",
      body: {
        external_id: `hermes:${run.id}`,
        workflow: workflow.name,
        step: "agent",
        traceparent: savedRun?.traceContext,
      },
    })
    expect(String(requests[0]?.body.prompt)).toBe("Reply about traces")
    expect(savedRun?.traceContext).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)

    const first = await engine.resumeExternalSession({
      externalSessionId: `hermes:${run.id}`,
      payload: { status: "completed", output: "HERMES_ACK", usage: { total_tokens: 7 } },
    })
    const duplicate = await engine.resumeExternalSession({
      externalSessionId: `hermes:${run.id}`,
      payload: { status: "completed", output: "HERMES_ACK", usage: { total_tokens: 7 } },
    })

    expect(first.status).toBe("resumed")
    expect(duplicate.status).toBe("duplicate")
    await engine.tick("test-worker", 5_000)
    expect((await store.getRun(run.id))?.context).toMatchObject({
      hermes_status: "completed",
      hermes_output: "HERMES_ACK",
      hermes_usage: { total_tokens: 7 },
    })
  })

  it("calls the runner cancellation endpoint for an open Hermes turn", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const workflow = defineWorkflow({
      name: "hermes-cancel-e2e",
      version: 1,
      startAt: "agent",
      steps: {
        agent: hermesTurn({ runner: makeRunner(requests), prompt: "wait" }),
        done: endStep(),
        "turn-failed": endStep(),
      },
    })
    const store = createStoreStub()
    const engine = createWorkflowEngine({ definitions: [workflow], metrics: createMetrics(), store })
    const run = await engine.startRun({ workflowName: workflow.name, payload: {} })

    await engine.tick("test-worker", 5_000)
    const canceled = await engine.cancelExternalSessionsForRun(run.id)

    expect(canceled.attempted).toBe(1)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual({
      url: `http://runner.test/turns/hermes%3A${run.id}/cancel`,
      body: {},
    })
  })
})
