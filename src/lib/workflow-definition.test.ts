import { describe, expect, it } from "vitest"

import { z } from "zod"
import {
  defineWorkflow,
  renderWorkflowAsMermaid,
  taskStep,
  task,
  wait,
  signal,
  sleep,
  end,
} from "./workflow-definition.js"
import type { StepExecutionContext } from "../types/workflow.js"
import { demoWorkflow } from "../workflows/demo.js"

describe("workflow rendering", () => {
  it("renders mermaid output", () => {
    const output = renderWorkflowAsMermaid(demoWorkflow)

    expect(output).toContain("flowchart TD")
    expect(output).toContain("Classify recipient")
    expect(output).toContain("Wait for provider callback")
    expect(output).toContain("step_0_classify_recipient --> step_1_send_email")
    expect(output).toContain("step_0_classify_recipient --> step_2_send_sms")
    expect(output).toContain("step_0_classify_recipient --> step_3_send_webhook")
  })

  it("highlights the current step with a Mermaid class", () => {
    const output = renderWorkflowAsMermaid(demoWorkflow, {
      highlightedStepKey: "delivery-confirmation",
    })

    expect(output).toContain("class step_5_delivery_confirmation currentStep")
    expect(output).toContain("classDef currentStep")
  })

  it("rejects workflows with missing step targets", () => {
    expect(() =>
      defineWorkflow({
        name: "broken",
        version: 1,
        startAt: "start",
        steps: {
          start: taskStep({
            kind: "task",
            next: "missing",
            run: () => ({}),
          }),
        },
      })
    ).toThrow('references missing target "missing"')
  })
})

describe("step builders", () => {
  it("creates task with Zod validation", async () => {
    const inputSchema = z.object({
      name: z.string(),
    })
    const outputSchema = z.object({
      greeting: z.string(),
    })

    const myTask = task({
      input: inputSchema,
      output: outputSchema,
      run: ({ input }) => {
        return {
          output: {
            greeting: `Hello, ${input.name}!`,
          },
        }
      },
    })

    expect(myTask.kind).toBe("task")

    const mockCtx = {
      input: { name: "Alice" },
      context: {},
      now: new Date(),
      attempt: 1,
      idempotencyKey: "123",
      heartbeat: async () => true,
      emit: async () => undefined,
      recordUsage: async () => undefined,
    } as unknown as StepExecutionContext

    const result = await myTask.run(mockCtx)
    expect(result.output).toEqual({ greeting: "Hello, Alice!" })

    const invalidCtx = {
      ...mockCtx,
      input: { name: 123 },
    } as unknown as StepExecutionContext

    await expect(myTask.run(invalidCtx)).rejects.toThrow()
  })

  it("wraps raw output returned from task runner", async () => {
    const myTask = task({
      run: () => {
        return "raw string output"
      },
    })

    const mockCtx = {
      input: {},
      context: {},
    } as unknown as StepExecutionContext

    const result = await myTask.run(mockCtx)
    expect(result).toEqual({ output: "raw string output" })
  })

  it("creates other step builders with correct kinds", () => {
    const myWait = wait({
      timeoutMs: 1000,
      open: () => ({ correlationKey: "123" }),
      resume: () => ({}),
    })
    expect(myWait.kind).toBe("wait")
    expect(myWait.timeoutMs).toBe(1000)

    const mySignal = signal({
      signal: "my-signal",
      timeoutMs: 5000,
      resume: () => ({}),
    })
    expect(mySignal.kind).toBe("signal")
    expect(mySignal.signal).toBe("my-signal")

    const mySleep = sleep({
      next: "done",
      until: 5000,
    })
    expect(mySleep.kind).toBe("sleep")
    expect(mySleep.next).toBe("done")

    const myEnd = end()
    expect(myEnd.kind).toBe("end")
  })
})
