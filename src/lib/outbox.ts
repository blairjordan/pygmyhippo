import type { WorkflowOutboxRecord } from "../types/workflow.js"
import type { WorkflowStore } from "./workflow-store.js"

export type OutboxHandler = (
  record: WorkflowOutboxRecord
) => Promise<void> | void

export const drainOutbox = async (args: {
  handlers: Record<string, OutboxHandler>
  limit: number
  onError?: (error: unknown, record: WorkflowOutboxRecord) => void
  store: WorkflowStore
}) => {
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
      await handler(record)
      const marked = await args.store.markOutboxDelivered(record.id)

      if (marked) {
        delivered += 1
      }
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
}) => {
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
        await drainOutbox({
          handlers: args.handlers,
          limit: args.limit,
          onError: (error, record) => {
            args.onError?.(error, record)
          },
          store: args.store,
        })
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
