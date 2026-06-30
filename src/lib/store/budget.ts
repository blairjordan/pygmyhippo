import type { StoreContext } from "./context.js"
import type { JsonObject } from "../../types/json.js"
import type {
  WorkflowBudget,
  WorkflowRunRecord,
  WorkflowUsageInput,
  WorkflowUsageRecord,
} from "../../types/workflow.js"

export class LostLeaseError extends Error {}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly run: WorkflowRunRecord,
    readonly usage: WorkflowUsageRecord
  ) {
    super(message)
  }
}

export class TransactionBudgetExceededError extends Error {
  constructor(
    readonly usage: WorkflowUsageInput,
    readonly exhausted: {
      resource: string
      limit: number
      total: number
    }
  ) {
    super("Workflow budget exhausted")
  }
}

export const createBudgetMethods = (ctx: StoreContext) => {
  const getBudgetExhaustion = (args: {
    budget: WorkflowBudget | undefined
    usage: WorkflowUsageInput
    resourceAmount: number
    costUsd: number
  }) => {
    const resourceLimit = args.budget?.resources?.[args.usage.resource]

    if (resourceLimit !== undefined && args.resourceAmount > resourceLimit) {
      return {
        resource: args.usage.resource,
        limit: resourceLimit,
        total: args.resourceAmount,
      }
    }

    if (args.budget?.costUsd !== undefined && args.costUsd > args.budget.costUsd) {
      return {
        resource: "costUsd",
        limit: args.budget.costUsd,
        total: args.costUsd,
      }
    }

    return null
  }

  const createBudgetErrorPayload = (args: {
    exhausted: {
      resource: string
      limit: number
      total: number
    }
    usage: WorkflowUsageInput
  }): JsonObject => ({
    message: `Workflow budget exhausted for ${args.exhausted.resource}`,
    resource: args.exhausted.resource,
    limit: args.exhausted.limit,
    total: args.exhausted.total,
    usage: {
      resource: args.usage.resource,
      amount: args.usage.amount,
      ...(args.usage.costUsd === undefined ? {} : { costUsd: args.usage.costUsd }),
      ...(args.usage.dimension === undefined
        ? {}
        : { dimension: args.usage.dimension }),
    },
  })

  const validateUsage = (usage: WorkflowUsageInput) => {
    if (usage.resource.trim().length === 0) {
      throw new Error("Usage resource must not be empty")
    }

    if (!Number.isFinite(usage.amount) || usage.amount < 0) {
      throw new Error("Usage amount must be a finite non-negative number")
    }

    if (
      usage.costUsd !== undefined &&
      (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)
    ) {
      throw new Error("Usage costUsd must be a finite non-negative number")
    }
  }

  return {
    getBudgetExhaustion,
    createBudgetErrorPayload,
    validateUsage,
  }
}
