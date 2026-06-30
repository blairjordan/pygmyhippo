import type { Database } from "../db.js"
import type { HippoTracer, TraceAttributes } from "../tracing.js"

export interface StoreContext {
  db: Database
  tracer: HippoTracer
  notifyRunnable: () => Promise<void>
  notifyRunEvent: (runId: string) => Promise<void>
  withStoreSpan: <T>(
    input: {
      name: string
      attributes?: TraceAttributes
    },
    run: () => Promise<T>
  ) => Promise<T>
  self: any
}
