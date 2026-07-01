import type { StoreContext } from "./context.js"
import type { WorkflowRunStatus } from "../../types/workflow.js"
import {
  listRuns as listRunsQuery,
  listRunLineage as listRunLineageQuery,
  listChildRuns as listChildRunsQuery,
} from "../../queries/workflow-store.queries.js"
import { mapRun, type IRunRow } from "./mappers.js"
import { createTraceAttributes } from "../tracing.js"

export const RUN_SELECT_COLUMNS = `
  id,
  parent_run_id AS "parentRunId",
  parent_step_key AS "parentStepKey",
  continued_from_run_id AS "continuedFromRunId",
  branched_from_run_id AS "branchedFromRunId",
  branched_from_attempt_run_id AS "branchedFromAttemptRunId",
  branched_from_attempt_id AS "branchedFromAttemptId",
  superseded_by_run_id AS "supersededByRunId",
  definition_name AS "definitionName",
  definition_version AS "definitionVersion",
  task_queue AS "taskQueue",
  priority,
  status,
  current_step_key AS "currentStepKey",
  input,
  context,
  result,
  error,
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  cancel_requested_at AS "cancelRequestedAt",
  cancel_mode AS "cancelMode",
  available_at AS "availableAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"
`

export const createOperatorQueries = (ctx: StoreContext) => {
  const { db, withStoreSpan } = ctx

  const queryRunsByPredicate = async (args: {
    predicateSql: string
    predicateValues: unknown[]
    limit: number
    afterUpdatedAt?: Date
    afterId?: string
  }) => {
    const values: unknown[] = [...args.predicateValues]
    const placeholder = () => `$${String(values.length)}`

    let cursorClause = ""
    if (args.afterUpdatedAt && args.afterId) {
      values.push(args.afterUpdatedAt)
      const ts = `${placeholder()}::timestamptz`
      values.push(args.afterId)
      const id = `${placeholder()}::uuid`
      cursorClause = ` AND (updated_at, id) < (${ts}, ${id})`
    }

    const safeLimit = Math.max(1, Math.min(500, Math.floor(args.limit)))

    const text = `
      SELECT ${RUN_SELECT_COLUMNS}
      FROM workflow_runs
      WHERE ${args.predicateSql}${cursorClause}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${String(safeLimit)}
    `

    const result = await db.query<IRunRow>(text, values as unknown[] as never[])
    return result.rows.map(mapRun)
  }

  const listActiveRuns = async (args: {
    limit: number
    afterUpdatedAt?: Date
    afterId?: string
  }) =>
    queryRunsByPredicate({
      predicateSql: "status IN ('queued', 'running', 'waiting')",
      predicateValues: [],
      limit: args.limit,
      ...(args.afterUpdatedAt ? { afterUpdatedAt: args.afterUpdatedAt } : {}),
      ...(args.afterId ? { afterId: args.afterId } : {}),
    })

  const listRuns = async (args: {
    limit: number
    parentRunId?: string
    search?: string
    status?: WorkflowRunStatus
    taskQueue?: string
    workflowName?: string
  }) => {
    const rows = await listRunsQuery.run(
      {
        limit: args.limit,
        parentRunId: args.parentRunId,
        search: args.search,
        status: args.status,
        taskQueue: args.taskQueue,
        workflowName: args.workflowName,
      },
      db
    )

    return rows.map(mapRun)
  }

  const listRunsPaginated = async (args: {
    limit: number
    statuses?: WorkflowRunStatus[]
    workflowName?: string
    search?: string
    parentRunId?: string
    taskQueue?: string
    afterUpdatedAt?: Date
    afterId?: string
    metadata?: Record<string, string | number | boolean>
  }) => {
    const conditions: string[] = []
    const values: unknown[] = []
    const placeholder = () => `$${String(values.length)}`

    if (args.statuses && args.statuses.length > 0) {
      values.push(args.statuses)
      conditions.push(`status::text = ANY(${placeholder()}::text[])`)
    }

    if (args.workflowName) {
      values.push(args.workflowName)
      conditions.push(`definition_name = ${placeholder()}::text`)
    }

    if (args.search) {
      values.push(`%${args.search}%`)
      const search = `${placeholder()}::text`
      conditions.push(
        `(id::text ILIKE ${search} OR definition_name ILIKE ${search} OR COALESCE(current_step_key, '') ILIKE ${search})`
      )
    }

    if (args.parentRunId) {
      values.push(args.parentRunId)
      conditions.push(`parent_run_id = ${placeholder()}::uuid`)
    }

    if (args.taskQueue) {
      values.push(args.taskQueue)
      conditions.push(`task_queue = ${placeholder()}::text`)
    }

    if (args.metadata && Object.keys(args.metadata).length > 0) {
      values.push(JSON.stringify(args.metadata))
      conditions.push(`metadata @> ${placeholder()}::jsonb`)
    }

    if (args.afterUpdatedAt && args.afterId) {
      values.push(args.afterUpdatedAt)
      const ts = `${placeholder()}::timestamptz`
      values.push(args.afterId)
      const id = `${placeholder()}::uuid`
      conditions.push(`(updated_at, id) < (${ts}, ${id})`)
    }

    const safeLimit = Math.max(1, Math.min(500, Math.floor(args.limit)))

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

    const text = `
      SELECT
        id,
        parent_run_id AS "parentRunId",
        parent_step_key AS "parentStepKey",
        continued_from_run_id AS "continuedFromRunId",
        branched_from_run_id AS "branchedFromRunId",
        branched_from_attempt_run_id AS "branchedFromAttemptRunId",
        branched_from_attempt_id AS "branchedFromAttemptId",
        superseded_by_run_id AS "supersededByRunId",
        definition_name AS "definitionName",
        definition_version AS "definitionVersion",
        task_queue AS "taskQueue",
        priority,
        status,
        current_step_key AS "currentStepKey",
        input,
        context,
        result,
        error,
        lease_owner AS "leaseOwner",
        lease_expires_at AS "leaseExpiresAt",
        cancel_requested_at AS "cancelRequestedAt",
        cancel_mode AS "cancelMode",
        available_at AS "availableAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt",
        metadata
      FROM workflow_runs
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${String(safeLimit)}
    `

    const result = await db.query<IRunRow>(text, values as unknown[] as never[])
    return result.rows.map(mapRun)
  }

  const listRunLineage = async (runId: string) => {
    const rows = await listRunLineageQuery.run({ runId }, db)
    return rows.flatMap((row) => {
      if (
        typeof row.id !== "string" ||
        typeof row.definitionName !== "string" ||
        typeof row.definitionVersion !== "number" ||
        typeof row.status !== "string" ||
        row.input === null ||
        row.context === null ||
        !(row.availableAt instanceof Date) ||
        !(row.createdAt instanceof Date) ||
        !(row.updatedAt instanceof Date)
      ) {
        return []
      }

      return [
        mapRun({
          id: row.id,
          parentRunId: row.parentRunId,
          parentStepKey: row.parentStepKey,
          continuedFromRunId: row.continuedFromRunId,
          branchedFromRunId: row.branchedFromRunId,
          branchedFromAttemptRunId: row.branchedFromAttemptRunId,
          branchedFromAttemptId: row.branchedFromAttemptId,
          supersededByRunId: row.supersededByRunId,
          definitionName: row.definitionName,
          definitionVersion: row.definitionVersion,
          status: row.status,
          currentStepKey: row.currentStepKey,
          input: row.input,
          context: row.context,
          result: row.result,
          error: row.error,
          leaseOwner: row.leaseOwner,
          leaseExpiresAt: row.leaseExpiresAt,
          cancelRequestedAt: row.cancelRequestedAt,
          cancelMode: row.cancelMode,
          availableAt: row.availableAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          completedAt: row.completedAt,
          ...(typeof row.taskQueue === "string"
            ? { taskQueue: row.taskQueue }
            : {}),
          ...(typeof row.priority === "number"
            ? { priority: row.priority }
            : {}),
        }),
      ]
    })
  }

  const listFailedRuns = async (args: {
    limit: number
    afterUpdatedAt?: Date
    afterId?: string
  }) =>
    queryRunsByPredicate({
      predicateSql:
        "status IN ('failed', 'compensation_failed', 'exhausted_budget')",
      predicateValues: [],
      limit: args.limit,
      ...(args.afterUpdatedAt ? { afterUpdatedAt: args.afterUpdatedAt } : {}),
      ...(args.afterId ? { afterId: args.afterId } : {}),
    })

  const listStuckRuns = async (args: {
    limit: number
    olderThanMs: number
    afterUpdatedAt?: Date
    afterId?: string
  }) => {
    const predicateValues: unknown[] = [args.olderThanMs]
    const predicateSql = `
      (
        (status = 'running' AND lease_expires_at < now())
        OR (
          status = 'waiting'
          AND updated_at <= now() - ($1::bigint * interval '1 millisecond')
        )
        OR (
          status = 'queued'
          AND available_at <= now() - ($1::bigint * interval '1 millisecond')
        )
      )
    `
    return queryRunsByPredicate({
      predicateSql,
      predicateValues,
      limit: args.limit,
      ...(args.afterUpdatedAt ? { afterUpdatedAt: args.afterUpdatedAt } : {}),
      ...(args.afterId ? { afterId: args.afterId } : {}),
    })
  }

  const listChildRuns = async (parentRunId: string) =>
    withStoreSpan(
      {
        name: "list_child_runs",
        attributes: createTraceAttributes({
          operation: "store.list_child_runs",
          runId: parentRunId,
        }),
      },
      async () => {
        const rows = await listChildRunsQuery.run({ parentRunId }, db)

        return rows.map(mapRun)
      }
    )

  return {
    queryRunsByPredicate,
    listActiveRuns,
    listFailedRuns,
    listStuckRuns,
    listRunsPaginated,
    listRunLineage,
    listRuns,
    listChildRuns,
  }
}
