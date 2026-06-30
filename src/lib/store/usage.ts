import type { PoolClient } from "pg"
import type { StoreContext } from "./context.js"
import type { JsonValue, JsonObject } from "../../types/json.js"
import type { WorkflowBudget, WorkflowUsageInput } from "../../types/workflow.js"
import {
  insertUsage as insertUsageQuery,
  getUsageTotals as getUsageTotalsQuery,
  exhaustRunBudget as exhaustRunBudgetQuery,
  getRunUsage as getRunUsageQuery,
} from "../../queries/workflow-store.queries.js"
import { mapUsage, mapRun, requireRow } from "./mappers.js"
import { createTraceAttributes } from "../tracing.js"
import { BudgetExceededError } from "./budget.js"
import type { Database } from "../db.js"

export const createUsageMethods = (ctx: StoreContext) => {
  const { db, notifyRunEvent, withStoreSpan, self } = ctx

  const insertUsage = async (args: {
    runId: string
    stepAttemptId: string | null
    usage: WorkflowUsageInput
    executor: Database | PoolClient
  }) => {
    self.validateUsage(args.usage)

    const [row] = await insertUsageQuery.run(
      {
        runId: args.runId,
        stepAttemptId: args.stepAttemptId,
        resource: args.usage.resource,
        amount: args.usage.amount,
        costUsd: args.usage.costUsd ?? null,
        dimension: args.usage.dimension ?? null,
      },
      args.executor
    )

    return mapUsage(requireRow(row, "Failed to insert workflow usage"))
  }

  const recordUsageWithExecutor = async (args: {
    runId: string
    stepKey: string | null
    stepAttemptId: string | null
    usage: WorkflowUsageInput
    budget: WorkflowBudget | undefined
    executor: Database | PoolClient
  }) => {
    const usage = await insertUsage({
      runId: args.runId,
      stepAttemptId: args.stepAttemptId,
      usage: args.usage,
      executor: args.executor,
    })
    const [totalsRow] = await getUsageTotalsQuery.run(
      {
        runId: args.runId,
        resource: args.usage.resource,
      },
      args.executor
    )
    const resourceAmount = Number(totalsRow?.resourceAmount ?? 0)
    const costUsd = Number(totalsRow?.costUsd ?? 0)
    const exhausted = self.getBudgetExhaustion({
      budget: args.budget,
      usage: args.usage,
      resourceAmount,
      costUsd,
    })

    if (!exhausted) {
      return { status: "recorded" as const, usage, run: null }
    }

    const error = self.createBudgetErrorPayload({
      exhausted,
      usage: args.usage,
    })
    const [row] = await exhaustRunBudgetQuery.run(
      {
        runId: args.runId,
        stepKey: args.stepKey,
        stepAttemptId: args.stepAttemptId,
        error,
      },
      args.executor
    )
    const run = mapRun(requireRow(row, "Failed to exhaust workflow budget"))
    return { status: "exhausted_budget" as const, usage, run }
  }

  const getRunUsage = async (runId: string) =>
    withStoreSpan(
      {
        name: "get_run_usage",
        attributes: createTraceAttributes({
          operation: "store.get_run_usage",
          runId,
        }),
      },
      async () => {
        const rows = await getRunUsageQuery.run({ runId }, db)
        return rows.map(mapUsage)
      }
    )

  const recordUsage = async (args: {
    runId: string
    stepKey: string | null
    stepAttemptId: string | null
    usage: WorkflowUsageInput
    budget?: WorkflowBudget
  }) =>
    withStoreSpan(
      {
        name: "record_usage",
        attributes: {
          ...createTraceAttributes({
            operation: "store.record_usage",
            runId: args.runId,
            stepKey: args.stepKey,
          }),
          "workflow.usage.resource": args.usage.resource,
        },
      },
      async () => {
        const result = await recordUsageWithExecutor({
          runId: args.runId,
          stepKey: args.stepKey,
          stepAttemptId: args.stepAttemptId,
          usage: args.usage,
          budget: args.budget,
          executor: db,
        })

        await notifyRunEvent(args.runId)

        if (result.run) {
          throw new BudgetExceededError(
            "Workflow budget exhausted",
            result.run,
            result.usage
          )
        }

        return result.usage
      }
    )

  const queryStepDatabase = async <
    T extends object = Record<string, unknown>,
  >(
    text: string,
    values: readonly unknown[] = []
  ) =>
    withStoreSpan(
      {
        name: "query_step_database",
        attributes: {
          "hippo.operation": "store.query_step_database",
        },
      },
      async () => {
        const result = await db.query<T>(text, [...values])
        return {
          rows: result.rows,
        }
      }
    )

  return {
    insertUsage,
    recordUsageWithExecutor,
    getRunUsage,
    recordUsage,
    queryStepDatabase,
  }
}
