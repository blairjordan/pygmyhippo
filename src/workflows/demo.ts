import { createHash } from "node:crypto"

import { defineWorkflow, endStep, taskStep, waitStep } from "../lib/workflow-definition.js"

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
      run: ({ input }) => ({
        patch: {
          provider: "email",
          outboundRequestId: createCorrelationKey(
            `${String(input.email)}:${Date.now()}`
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
      run: ({ input }) => ({
        patch: {
          provider: "sms",
          outboundRequestId: createCorrelationKey(
            `${String(input.phoneNumber)}:${Date.now()}`
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
      next: "delivery-confirmation",
      run: ({ input }) => ({
        patch: {
          provider: "webhook",
          outboundRequestId: createCorrelationKey(
            `${String(input.url)}:${Date.now()}`
          ),
        },
        output: {
          accepted: true,
        },
      }),
    }),
    "delivery-confirmation": waitStep({
      kind: "wait",
      label: "Wait for provider callback",
      next: "done",
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
