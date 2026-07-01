import { createHash } from "node:crypto"

import {
  defineWorkflow,
  endStep,
  sleepStep,
  taskStep,
  waitStep,
  childStep,
  fanOut,
} from "../lib/workflow-definition.js"

const createCorrelationKey = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24)

export const demoWorkflow = defineWorkflow({
  name: "demo-delivery",
  version: 1,
  title: "Demo delivery workflow",
  startAt: "classify-recipient",
  steps: {
    "classify-recipient": taskStep({
      kind: "task",
      label: "Classify recipient",
      transitions: {
        email: "send-email",
        sms: "send-sms",
        webhook: "send-webhook",
      },
      run: ({ input }) => {
        const recipientType =
          typeof input.email === "string"
            ? "email"
            : typeof input.phoneNumber === "string"
              ? "sms"
              : "webhook"

        return {
          patch: { recipientType },
          transition:
            recipientType === "email"
              ? "send-email"
              : recipientType === "sms"
                ? "send-sms"
                : "send-webhook",
        }
      },
    }),
    "send-email": taskStep({
      kind: "task",
      label: "Send email",
      next: "delivery-confirmation",
      retry: {
        maxAttempts: 3,
        initialBackoffMs: 1_000,
      },
      run: ({ idempotencyKey, input }) => ({
        patch: {
          provider: "email",
          outboundRequestId: createCorrelationKey(
            `${idempotencyKey}:email:${String(input.email)}`
          ),
        },
        output: {
          accepted: true,
        },
      }),
    }),
    "send-sms": taskStep({
      kind: "task",
      label: "Send SMS",
      next: "delivery-confirmation",
      retry: {
        maxAttempts: 3,
        initialBackoffMs: 1_000,
      },
      run: ({ idempotencyKey, input }) => ({
        patch: {
          provider: "sms",
          outboundRequestId: createCorrelationKey(
            `${idempotencyKey}:sms:${String(input.phoneNumber)}`
          ),
        },
        output: {
          accepted: true,
        },
      }),
    }),
    "send-webhook": taskStep({
      kind: "task",
      label: "Send webhook",
      next: "cooldown",
      retry: {
        maxAttempts: 3,
        initialBackoffMs: 1_000,
      },
      run: ({ idempotencyKey, input }) => ({
        patch: {
          provider: "webhook",
          outboundRequestId: createCorrelationKey(
            `${idempotencyKey}:webhook:${String(input.url)}`
          ),
        },
        output: {
          accepted: true,
        },
      }),
    }),
    cooldown: sleepStep({
      kind: "sleep",
      label: "Cooldown",
      next: "delivery-confirmation",
      until: 5_000,
    }),
    "delivery-confirmation": waitStep({
      kind: "wait",
      label: "Wait for provider callback",
      next: "done",
      timeoutMs: 86_400_000,
      open: ({ run, context }) => ({
        correlationKey: createCorrelationKey(
          `${run.id}:${String(context.outboundRequestId ?? "missing")}`
        ),
        payload: {
          outboundRequestId: context.outboundRequestId ?? null,
        },
      }),
      resume: (_context, payload) => ({
        patch: {
          providerResponse: payload ?? { status: "delivered" },
        },
      }),
    }),
    done: endStep({
      label: "Completed",
    }),
  },
})

export const demoChildWorkflow = defineWorkflow({
  name: "demo-child-work",
  version: 1,
  title: "Demo Child Task",
  startAt: "process-subtask",
  steps: {
    "process-subtask": taskStep({
      kind: "task",
      next: "done",
      run: async ({ input }) => {
        const duration = typeof input?.delay === "number" ? input.delay : 1000
        await new Promise((r) => setTimeout(r, duration))
        return {
          patch: { processed: true, delayUsed: duration },
        }
      },
    }),
    done: endStep(),
  },
})

export const demoParentWorkflow = defineWorkflow({
  name: "demo-parent-flow",
  version: 1,
  title: "Demo Parent Workflow",
  startAt: "prepare",
  steps: {
    prepare: taskStep({
      kind: "task",
      next: "spawn-child",
      run: async () => {
        await new Promise((r) => setTimeout(r, 800))
        return {
          patch: { initialized: true },
        }
      },
    }),
    "spawn-child": childStep({
      kind: "child",
      workflow: "demo-child-work",
      next: "fan-out-children",
      input: () => ({
        delay: 1500,
      }),
      resume: (_context, childRun) => ({
        patch: {
          singleChildStatus: childRun.status,
        },
      }),
    }),
    "fan-out-children": fanOut({
      next: "cooldown",
      failureMode: "collect",
      children: () => [
        { workflow: "demo-child-work", input: { delay: 1000 } },
        { workflow: "demo-child-work", input: { delay: 2000 } },
        { workflow: "demo-child-work", input: { delay: 1500 } },
      ],
      resume: (_context, childRuns) => ({
        patch: {
          childStatuses: childRuns.map((r) => r.status),
        },
      }),
    }),
    cooldown: sleepStep({
      kind: "sleep",
      next: "done",
      until: 1000,
    }),
    done: endStep(),
  },
})
