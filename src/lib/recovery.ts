import type { HippoMetrics } from "./metrics.js"
import { createHippoTracer, type HippoTracer } from "./tracing.js"
import type { WorkflowStore } from "./workflow-store.js"

export const runRecoveryPass = async (args: {
  metrics: HippoMetrics
  store: WorkflowStore
  limit: number
  tracer?: HippoTracer
}) => {
  const tracer = args.tracer ?? createHippoTracer()

  return tracer.withSpan(
    {
      name: "hippo.recovery.pass",
      attributes: {
        "hippo.operation": "recovery.pass",
        "workflow.recovery.limit": args.limit,
      },
    },
    async () => {
      const reclaimed = await args.store.recoverExpiredLeases({
        limit: args.limit,
      })

      if (reclaimed > 0) {
        args.metrics.leaseReclaims.inc(reclaimed)
        args.metrics.recoveryActions.inc(
          {
            action: "requeue_expired_lease",
          },
          reclaimed
        )
      }

      const expiredWaits = await args.store.expireOpenWaits({
        limit: args.limit,
      })

      if (expiredWaits > 0) {
        args.metrics.recoveryActions.inc(
          {
            action: "expire_wait",
          },
          expiredWaits
        )
      }

      return reclaimed + expiredWaits
    }
  )
}

export const startRecoveryLoop = (args: {
  intervalMs: number
  limit: number
  metrics: HippoMetrics
  onError?: (error: unknown) => void
  store: WorkflowStore
  tracer?: HippoTracer
}) => {
  const tracer = args.tracer ?? createHippoTracer()
  let active = true
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlightPromise: Promise<void> | null = null

  const schedule = () => {
    if (!active) {
      return
    }

    timer = setTimeout(() => {
      timer = null
      void tick()
    }, args.intervalMs)
  }

  const tick = async () => {
    if (!active || inFlight) {
      schedule()
      return
    }

    inFlight = true
    inFlightPromise = (async () => {
      try {
        await tracer.withSpan(
          {
            name: "hippo.recovery.tick",
            attributes: {
              "hippo.operation": "recovery.tick",
              "workflow.recovery.limit": args.limit,
            },
          },
          () =>
            runRecoveryPass({
          limit: args.limit,
          metrics: args.metrics,
          store: args.store,
              tracer,
            })
        )
      } catch (error) {
        args.onError?.(error)
      } finally {
        inFlight = false
        inFlightPromise = null
        schedule()
      }
    })()

    await inFlightPromise
  }

  void tick()

  return async () => {
    active = false

    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    await inFlightPromise
  }
}
