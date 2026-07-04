import type { StoreContext } from "./context.js"
import type { WorkflowCancelMode } from "../../types/workflow.js"
import {
  cancelRun as cancelRunQuery,
  cancelRunAtBoundary as cancelRunAtBoundaryQuery,
  requestCancelRun as requestCancelRunQuery,
  claimNextRunnableRun as claimNextRunnableRunQuery,
  recoverExpiredLeases as recoverExpiredLeasesQuery,
  extendLease as extendLeaseQuery,
  ping as pingQuery,
} from "../../queries/workflow-store.queries.js"
import { mapRun, requireRow } from "./mappers.js"
import { withTransaction } from "../db.js"
import { createTraceAttributes } from "../tracing.js"

export const createRunControlMethods = (ctx: StoreContext) => {
  const { db, notifyRunnable, notifyRunEvent, withStoreSpan, self } = ctx

  const cancelRun = async (args: {
    runId: string
    reason?: string
  }) =>
    withStoreSpan(
      {
        name: "cancel_run",
        attributes: createTraceAttributes({
          operation: "store.cancel_run",
          runId: args.runId,
        }),
      },
      async () => {
        const [row] = await cancelRunQuery.run(
          {
            runId: args.runId,
            eventType: "run.canceled",
            eventPayload: args.reason ? { reason: args.reason } : {},
          },
          db
        )

        if (!row) {
          return null
        }

        const run = mapRun(row)
        await notifyRunnable()
        await notifyRunEvent(run.id)
        return run
      }
    )

  const cancelRunAtBoundary = async (args: {
    runId: string
    stepKey: string
    workerId: string
    mode: WorkflowCancelMode
  }) => {
    const [row] = await cancelRunAtBoundaryQuery.run(args, db)

    if (!row) {
      return null
    }

    const run = (await self.getRun(mapRun(row).id)) ?? mapRun(row)
    await notifyRunEvent(run.id)
    await self.wakeParentForChild(run)
    return run
  }

  const requestCancelRun = async (args: {
    runId: string
    mode: WorkflowCancelMode
    reason?: string
  }) =>
    withStoreSpan(
      {
        name: "request_cancel_run",
        attributes: createTraceAttributes({
          operation: "store.request_cancel_run",
          runId: args.runId,
        }),
      },
      async () => {
        const eventType =
          args.mode === "hard" ? "run.canceled" : "run.cancel_requested"
        const eventPayload = {
          mode: args.mode,
          ...(args.reason ? { reason: args.reason } : {}),
        }
        const [row] = await requestCancelRunQuery.run(
          {
            runId: args.runId,
            mode: args.mode,
            eventType,
            eventPayload,
          },
          db
        )

        if (row) {
          const run = mapRun(row)
          await notifyRunnable()
          await notifyRunEvent(run.id)

          if (args.mode === "hard") {
            await self.wakeParentForChild(run)
          }

          return run
        }

        return null
      }
    )

  const claimNextRunnableRun = async (args: {
    workerId: string
    leaseMs: number
    taskQueues: string[]
  }) =>
    withStoreSpan(
      {
        name: "claim_next_runnable_run",
        attributes: {
          ...createTraceAttributes({
            operation: "store.claim_next_runnable_run",
            workerId: args.workerId,
          }),
          "workflow.task_queue_count": args.taskQueues.length,
        },
      },
      () =>
        withTransaction(db, async (client) => {
          const [row] = await claimNextRunnableRunQuery.run(args, client)
          return row ? mapRun(row) : null
        })
    )

  const recoverExpiredLeases = async (args: { limit: number }) =>
    withStoreSpan(
      {
        name: "recover_expired_leases",
        attributes: {
          "hippo.operation": "store.recover_expired_leases",
          "workflow.recovery.limit": args.limit,
        },
      },
      async () => {
        const [row] = await recoverExpiredLeasesQuery.run(args, db)
        const reclaimed = requireRow(
          row,
          "Failed to recover expired leases"
        ).reclaimedCount ?? 0

        if (reclaimed > 0) {
          await notifyRunnable()
        }

        return reclaimed
      }
    )

  const extendLease = async (args: {
    runId: string
    stepKey: string
    attemptId: string
    workerId: string
    leaseMs: number
  }) => {
    const [row] = await extendLeaseQuery.run(args, db)
    return requireRow(row, "Failed to extend lease").ok === 1
  }

  const ping = async () => {
    const [row] = await pingQuery.run(undefined, db)
    return requireRow(row, "Database ping failed").ok === 1
  }

  return {
    cancelRun,
    cancelRunAtBoundary,
    requestCancelRun,
    claimNextRunnableRun,
    recoverExpiredLeases,
    extendLease,
    ping,
  }
}
