import type { PoolClient } from "pg"
import type { JsonObject } from "../../types/json.js"
import type {
  WorkflowBudget,
  WorkflowRunRecord,
  WorkflowUsageInput,
  WorkflowUsageRecord,
} from "../../types/workflow.js"
import type { Database } from "../db.js"
import type { HippoTracer, TraceAttributes } from "../tracing.js"
import type { WorkflowStore } from "../workflow-store.js"

type BudgetExhaustion = {
  resource: string
  limit: number
  total: number
}

export type StoreSelf = WorkflowStore & {
  createBudgetErrorPayload: (args: {
    exhausted: BudgetExhaustion
    usage: WorkflowUsageInput
  }) => JsonObject
  getBudgetExhaustion: (args: {
    budget: WorkflowBudget | undefined
    usage: WorkflowUsageInput
    resourceAmount: number
    costUsd: number
  }) => BudgetExhaustion | null
  insertUsage: (args: {
    runId: string
    stepAttemptId: string | null
    usage: WorkflowUsageInput
    executor: Database | PoolClient
  }) => Promise<WorkflowUsageRecord>
  recordUsageWithExecutor: (args: {
    runId: string
    stepKey: string | null
    stepAttemptId: string | null
    usage: WorkflowUsageInput
    budget: WorkflowBudget | undefined
    executor: Database | PoolClient
  }) => Promise<
    | { status: "recorded"; usage: WorkflowUsageRecord; run: null }
    | {
        status: "exhausted_budget"
        usage: WorkflowUsageRecord
        run: WorkflowRunRecord
      }
  >
  validateUsage: (usage: WorkflowUsageInput) => void
}

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
  self: StoreSelf
}
