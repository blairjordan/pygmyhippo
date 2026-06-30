import type { StoreContext } from "./context.js"
import type { JsonObject, JsonValue } from "../../types/json.js"
import type { WorkflowRunRecord } from "../../types/workflow.js"
import {
  createSignal as createSignalQuery,
  consumeSignal as consumeSignalQuery,
  getOpenWaitForUpdate as getOpenWaitForUpdateQuery,
  getRunByIdForUpdate as getRunByIdForUpdateQuery,
  completeWaitResume as completeWaitResumeQuery,
} from "../../queries/workflow-store.queries.js"
import { mapSignal, mapWait, mapRun, requireRow } from "./mappers.js"
import { withTransaction } from "../db.js"
import { createTraceAttributes } from "../tracing.js"

export const createSignalMethods = (ctx: StoreContext) => {
  const { db, notifyRunnable, notifyRunEvent, withStoreSpan } = ctx

  const createSignal = async (args: {
    runId: string
    signalName: string
    payload: JsonValue | null
  }) =>
    withStoreSpan(
      {
        name: "create_signal",
        attributes: {
          ...createTraceAttributes({
            operation: "store.create_signal",
            runId: args.runId,
          }),
          "workflow.signal.name": args.signalName,
        },
      },
      async () => {
        const [row] = await createSignalQuery.run(args, db)

        if (row) {
          await notifyRunnable()
          return row.runId
        }

        return null
      }
    )

  const consumeSignal = async (args: {
    runId: string
    signalName: string
  }) =>
    withStoreSpan(
      {
        name: "consume_signal",
        attributes: {
          ...createTraceAttributes({
            operation: "store.consume_signal",
            runId: args.runId,
          }),
          "workflow.signal.name": args.signalName,
        },
      },
      async () => {
        const [row] = await consumeSignalQuery.run(args, db)
        return row ? mapSignal(row) : null
      }
    )

  const consumeSignalAndResumeWait = async (args: {
    correlationKey: string
    signalName: string
    correlationValue?: string
    resume: (signalPayload: JsonValue | undefined) => Promise<{
      nextStepKey: string
      context: JsonObject
      output: JsonValue | null
    }>
  }): Promise<{
    status: "resumed" | "no_signal" | "duplicate" | "missing"
    run: WorkflowRunRecord | null
  }> =>
    withStoreSpan(
      {
        name: "consume_signal_and_resume_wait",
        attributes: {
          "hippo.operation": "store.consume_signal_and_resume_wait",
          "workflow.wait.correlation_key": args.correlationKey,
          "workflow.signal.name": args.signalName,
        },
      },
      () =>
        withTransaction(db, async (client) => {
          const [waitRow] = await getOpenWaitForUpdateQuery.run(
            { correlationKey: args.correlationKey },
            client
          )

          if (!waitRow) {
            return { status: "missing" as const, run: null }
          }

          const wait = mapWait(waitRow)
          const [runRow] = await getRunByIdForUpdateQuery.run(
            { runId: wait.runId },
            client
          )
          const run = mapRun(requireRow(runRow, "Failed to load waiting run"))

          if (wait.status !== "open") {
            return { status: "duplicate" as const, run }
          }

          if (run.status !== "waiting" || run.currentStepKey !== wait.stepKey) {
            return { status: "duplicate" as const, run }
          }

          const [signalRow] = await consumeSignalQuery.run(
            { runId: run.id, signalName: args.signalName },
            client
          )

          if (!signalRow) {
            return { status: "no_signal" as const, run }
          }

          const signal = mapSignal(signalRow)
          const resumed = await args.resume(signal.payload ?? undefined)

          const [updatedRow] = await completeWaitResumeQuery.run(
            {
              waitId: wait.id,
              runId: run.id,
              stepKey: wait.stepKey,
              nextStepKey: resumed.nextStepKey,
              context: resumed.context,
              resumePayload: signal.payload,
              output: resumed.output,
              eventType: "wait.resumed",
              eventPayload: {
                nextStepKey: resumed.nextStepKey,
                resumePayload: signal.payload,
              },
            },
            client
          )

          if (!updatedRow) {
            return { status: "duplicate" as const, run }
          }

          const resumedRun = mapRun(updatedRow)
          await notifyRunnable()
          await notifyRunEvent(resumedRun.id)
          return { status: "resumed" as const, run: resumedRun }
        })
    )

  return {
    createSignal,
    consumeSignal,
    consumeSignalAndResumeWait,
  }
}
