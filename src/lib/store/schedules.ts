import type { StoreContext } from "./context.js"
import type { JsonObject } from "../../types/json.js"
import type { WorkflowScheduleRecord } from "../../types/workflow.js"
import {
  createSchedule as createScheduleQuery,
  listSchedules as listSchedulesQuery,
  claimDueSchedules as claimDueSchedulesQuery,
  rescheduleAfterFire as rescheduleAfterFireQuery,
} from "../../queries/workflow-store.queries.js"
import { mapSchedule, requireRow } from "./mappers.js"
import { withTransaction } from "../db.js"
import { createTraceAttributes } from "../tracing.js"

export const createScheduleMethods = (ctx: StoreContext) => {
  const { db, withStoreSpan } = ctx

  const createSchedule = async (args: {
    workflowName: string
    cronExpression: string
    payload?: JsonObject
    taskQueue: string
    priority: number
    nextFireAt: Date
  }) =>
    withStoreSpan(
      {
        name: "create_schedule",
        attributes: {
          ...createTraceAttributes({
            operation: "store.create_schedule",
            workflowName: args.workflowName,
            taskQueue: args.taskQueue,
          }),
          "workflow.schedule.cron": args.cronExpression,
        },
      },
      async () => {
        const rows = await createScheduleQuery.run(
          {
            workflowName: args.workflowName,
            cronExpression: args.cronExpression,
            payload: args.payload ?? {},
            taskQueue: args.taskQueue,
            priority: args.priority,
            nextFireAt: args.nextFireAt,
          },
          db
        )

        return mapSchedule(requireRow(rows[0], "Failed to create schedule"))
      }
    )

  const listSchedules = async () => {
    const rows = await listSchedulesQuery.run(undefined, db)

    return rows.map(mapSchedule)
  }

  const fireDueSchedules = async (args: {
    limit: number
    getNextFireAt: (input: {
      schedule: WorkflowScheduleRecord
      now: Date
    }) => Date
  }) =>
    withStoreSpan(
      {
        name: "fire_due_schedules",
        attributes: {
          "hippo.operation": "store.fire_due_schedules",
          "workflow.schedule.limit": args.limit,
        },
      },
      () =>
        withTransaction(db, async (client) => {
          const scheduleRows = await claimDueSchedulesQuery.run(
            { limit: args.limit },
            client
          )
          const now = new Date()
          const fired: WorkflowScheduleRecord[] = []

          for (const row of scheduleRows) {
            const schedule = mapSchedule(row)
            const nextFireAt = args.getNextFireAt({ schedule, now })

            await rescheduleAfterFireQuery.run(
              {
                id: schedule.id,
                nextFireAt,
              },
              client
            )
            fired.push(schedule)
          }

          return fired
        })
    )

  return {
    createSchedule,
    listSchedules,
    fireDueSchedules,
  }
}
