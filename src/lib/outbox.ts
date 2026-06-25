import type { WorkflowOutboxRecord } from "../types/workflow.js"
import { createHippoTracer, type HippoTracer } from "./tracing.js"
import type { WorkflowStore } from "./workflow-store.js"

export type OutboxHandler = (
  record: WorkflowOutboxRecord
) => Promise<void> | void

export const drainOutbox = async (args: {
  handlers: Record<string, OutboxHandler>
  limit: number
  onError?: (error: unknown, record: WorkflowOutboxRecord) => void
  store: WorkflowStore
  tracer?: HippoTracer
}) => {
  const tracer = args.tracer ?? createHippoTracer()
  const records = await args.store.claimOutboxMessages(args.limit)
  let delivered = 0

  for (const record of records) {
    const handler = args.handlers[record.topic]

    if (!handler) {
      args.onError?.(
        new Error(`No outbox handler registered for topic "${record.topic}"`),
        record
      )
      continue
    }

    try {
      await tracer.withSpan(
        {
          name: "hippo.outbox.deliver",
          attributes: {
            "hippo.operation": "outbox.deliver",
            "workflow.outbox.id": record.id,
            "workflow.outbox.topic": record.topic,
            ...(record.runId === null ? {} : { "workflow.run.id": record.runId }),
          },
        },
        async () => {
          await handler(record)
          const marked = await args.store.markOutboxDelivered(record.id)

          if (marked) {
            delivered += 1
          }
        }
      )
    } catch (error) {
      args.onError?.(error, record)
    }
  }

  return delivered
}

export const startOutboxLoop = (args: {
  handlers: Record<string, OutboxHandler>
  intervalMs: number
  limit: number
  onError?: (error: unknown, record?: WorkflowOutboxRecord) => void
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
            name: "hippo.outbox.tick",
            attributes: {
              "hippo.operation": "outbox.tick",
              "workflow.outbox.limit": args.limit,
            },
          },
          () =>
            drainOutbox({
          handlers: args.handlers,
          limit: args.limit,
          onError: (error, record) => {
            args.onError?.(error, record)
          },
          store: args.store,
              tracer,
            })
        )
      } finally {
        inFlight = false
        inFlightPromise = null
        schedule()
      }
    })()

    await inFlightPromise
  }

  if (Object.keys(args.handlers).length > 0) {
    void tick()
  }

  return async () => {
    active = false

    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    await inFlightPromise
  }
}
