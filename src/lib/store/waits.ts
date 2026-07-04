import type { StoreContext } from "./context.js"
import type { JsonValue, JsonObject } from "../../types/json.js"
import type {
  WorkflowWaitRecord,
  WorkflowRunRecord,
} from "../../types/workflow.js"
import {
  openWait as openWaitQuery,
  openFanOutWaits as openFanOutWaitsQuery,
  countOpenWaits as countOpenWaitsQuery,
  expireOpenWaits as expireOpenWaitsQuery,
  listStepWaits as listStepWaitsQuery,
  completeWaitResume as completeWaitResumeQuery,
  recordExternalSessionEvent as recordExternalSessionEventQuery,
  recordExternalHeartbeat as recordExternalHeartbeatQuery,
  listOpenExternalSessions as listOpenExternalSessionsQuery,
  getOpenWaitForUpdate as getOpenWaitForUpdateQuery,
  getRunByIdForUpdate as getRunByIdForUpdateQuery,
  updateWaitStatus as updateWaitStatusQuery,
  completeExpiredWaitTransition as completeExpiredWaitTransitionQuery,
  failExpiredWaitRun as failExpiredWaitRunQuery,
  listChildRuns as listChildRunsQuery,
  requestCancelRun as requestCancelRunQuery,
  queueWaitingRun as queueWaitingRunQuery,
  getFanOutWaitByChildRunId as getFanOutWaitByChildRunIdQuery,
} from "../../queries/workflow-store.queries.js"
import {
  mapWait,
  mapRun,
  requireRow,
  terminalRunStatuses,
  type IWaitRow,
} from "./mappers.js"
import {
  getFanOutJoinState,
  getFanOutWaitPayload,
  groupFanOutWaitsByChildRunId,
  isFanOutWaitPayload,
} from "../engine/fan-out.js"
import { isHumanTaskWaitPayload } from "../engine/human-task.js"
import { withTransaction, type Database } from "../db.js"
import { createTraceAttributes } from "../tracing.js"
import { LostLeaseError } from "./budget.js"

export const createWaitsMethods = (ctx: StoreContext) => {
  const { db, notifyRunnable, notifyRunEvent, withStoreSpan, self } = ctx

  const countOpenWaits = async () => {
    const [row] = await countOpenWaitsQuery.run(undefined, db)
    return requireRow(row, "Failed to count open waits").waitCount ?? 0
  }

  const listStepWaits = async (args: { runId: string; stepKey: string }) =>
    withStoreSpan(
      {
        name: "list_step_waits",
        attributes: createTraceAttributes({
          operation: "store.list_step_waits",
          runId: args.runId,
          stepKey: args.stepKey,
        }),
      },
      async () => {
        const rows = await listStepWaitsQuery.run(args, db)
        return rows.map(mapWait)
      }
    )

  const openWait = async (args: {
    runId: string
    stepKey: string
    workerId: string
    attemptId: string
    context: JsonObject
    correlationKey: string
    payload: JsonValue | null
    expiresAt: Date | null
    output: JsonValue | null
    externalSessionId?: string | null
    externalSessionKind?: string | null
  }) =>
    withStoreSpan(
      {
        name: "open_wait",
        attributes: createTraceAttributes({
          operation: "store.open_wait",
          runId: args.runId,
          stepKey: args.stepKey,
          workerId: args.workerId,
        }),
      },
      async () => {
        const [row] = await openWaitQuery.run(
          {
            ...args,
            eventType: "wait.opened",
            eventPayload: { correlationKey: args.correlationKey },
          },
          db
        )

        if (!row) {
          throw new LostLeaseError("Failed to open wait under active lease")
        }

        const run = mapRun(row)
        await notifyRunEvent(run.id)
        return run
      }
    )

  const openFanOutWaits = async (args: {
    runId: string
    stepKey: string
    workerId: string
    attemptId: string
    context: JsonObject
    waits: Array<{
      correlationKey: string
      payload: JsonObject
      expiresAt: Date | null
    }>
    output: JsonValue | null
  }) =>
    withStoreSpan(
      {
        name: "open_fanout_waits",
        attributes: createTraceAttributes({
          operation: "store.open_fanout_waits",
          runId: args.runId,
          stepKey: args.stepKey,
          workerId: args.workerId,
        }),
      },
      () =>
        withTransaction(db, async (client) => {
          const [row] = await openFanOutWaitsQuery.run(
            {
              runId: args.runId,
              stepKey: args.stepKey,
              workerId: args.workerId,
              attemptId: args.attemptId,
              context: args.context,
              output: args.output,
              eventType: "wait.opened",
              eventPayload: { fanOut: true },
            },
            client
          )

          if (!row) {
            throw new LostLeaseError("Failed to open fan-out waits under active lease")
          }

          for (const item of args.waits) {
            await client.query(
              `
                INSERT INTO workflow_waits (
                  run_id,
                  step_key,
                  correlation_key,
                  status,
                  payload,
                  expires_at
                ) VALUES ($1, $2, $3, 'open', $4, $5)
              `,
              [
                args.runId,
                args.stepKey,
                item.correlationKey,
                item.payload,
                item.expiresAt,
              ]
            )
          }

          const run = mapRun(row)
          await notifyRunEvent(run.id)
          return run
        })
    )

  const resumeWait = async (args: {
    correlationKey: string
    payload: JsonValue | undefined
    resume: (
      run: WorkflowRunRecord,
      wait: WorkflowWaitRecord
    ) => Promise<{
      nextStepKey: string
      context: JsonObject
      output: JsonValue | null
    }>
  }) =>
    withStoreSpan(
      {
        name: "resume_wait",
        attributes: {
          "hippo.operation": "store.resume_wait",
          "workflow.wait.correlation_key": args.correlationKey,
        },
      },
      () =>
        withTransaction(db, async (client) => {
          const [waitRow] = await getOpenWaitForUpdateQuery.run(
            { correlationKey: args.correlationKey },
            client
          )

          if (!waitRow) {
            return { status: "missing" as const, run: null }
          }

          const wait = mapWait(waitRow)
          const [runRow] = await getRunByIdForUpdateQuery.run(
            { runId: wait.runId },
            client
          )
          const run = mapRun(requireRow(runRow, "Failed to load waiting run"))

          if (wait.status !== "open") {
            return { status: "duplicate" as const, run }
          }

          if (run.status !== "waiting" || run.currentStepKey !== wait.stepKey) {
            return { status: "duplicate" as const, run }
          }

          const resumed = await args.resume(run, wait)

          const [updatedRow] = await completeWaitResumeQuery.run(
            {
              waitId: wait.id,
              runId: run.id,
              stepKey: wait.stepKey,
              nextStepKey: resumed.nextStepKey,
              context: resumed.context,
              resumePayload: args.payload ?? null,
              output: resumed.output,
              eventType: "wait.resumed",
              eventPayload: {
                nextStepKey: resumed.nextStepKey,
                resumePayload: args.payload ?? null,
              },
            },
            client
          )

          if (!updatedRow) {
            return { status: "duplicate" as const, run }
          }

          const resumedRun = mapRun(updatedRow)
          await notifyRunnable()
          await notifyRunEvent(resumedRun.id)
          return { status: "resumed" as const, run: resumedRun }
        })
    )

  const resumeExternalSession = async (args: {
    externalSessionId: string
    payload: JsonValue | undefined
    resume: (
      run: WorkflowRunRecord,
      wait: WorkflowWaitRecord
    ) => Promise<{
      nextStepKey: string
      context: JsonObject
      output: JsonValue | null
    }>
  }) =>
    withStoreSpan(
      {
        name: "resume_external_session",
        attributes: {
          "hippo.operation": "store.resume_external_session",
          "workflow.external_session.id": args.externalSessionId,
        },
      },
      () =>
        withTransaction(db, async (client) => {
          const waitResult = await client.query<IWaitRow>(
            `
              SELECT
                id,
                run_id AS "runId",
                step_key AS "stepKey",
                correlation_key AS "correlationKey",
                status,
                payload,
                resume_payload AS "resumePayload",
                resume_output AS "resumeOutput",
                expires_at AS "expiresAt",
                created_at AS "createdAt",
                updated_at AS "updatedAt",
                resumed_at AS "resumedAt",
                external_session_id AS "externalSessionId",
                external_session_kind AS "externalSessionKind"
              FROM workflow_waits
              WHERE external_session_id = $1
              ORDER BY created_at DESC
              LIMIT 1
              FOR UPDATE
            `,
            [args.externalSessionId]
          )
          const waitRow = waitResult.rows[0]

          if (!waitRow) {
            return { status: "missing" as const, run: null }
          }

          const wait = mapWait(waitRow)
          const [runRow] = await getRunByIdForUpdateQuery.run(
            { runId: wait.runId },
            client
          )
          const run = mapRun(requireRow(runRow, "Failed to load waiting run"))

          if (wait.status !== "open") {
            return { status: "duplicate" as const, run }
          }

          if (run.status !== "waiting" || run.currentStepKey !== wait.stepKey) {
            return { status: "duplicate" as const, run }
          }

          const resumed = await args.resume(run, wait)

          const [updatedRow] = await completeWaitResumeQuery.run(
            {
              waitId: wait.id,
              runId: run.id,
              stepKey: wait.stepKey,
              nextStepKey: resumed.nextStepKey,
              context: resumed.context,
              resumePayload: args.payload ?? null,
              output: resumed.output,
              eventType: "wait.resumed",
              eventPayload: {
                nextStepKey: resumed.nextStepKey,
                resumePayload: args.payload ?? null,
              },
            },
            client
          )

          if (!updatedRow) {
            return { status: "duplicate" as const, run }
          }

          const resumedRun = mapRun(updatedRow)
          await notifyRunnable()
          await notifyRunEvent(resumedRun.id)
          return { status: "resumed" as const, run: resumedRun }
        })
    )

  const recordExternalSessionEvent = async (args: {
    externalSessionId: string
    type: string
    data: JsonValue
  }) =>
    withStoreSpan(
      {
        name: "record_external_session_event",
        attributes: {
          "hippo.operation": "store.record_external_session_event",
          "workflow.external_session.id": args.externalSessionId,
          "workflow.event_type": args.type,
        },
      },
      async () => {
        if (args.type.trim().length === 0) {
          throw new Error("Step event type must not be empty")
        }

        const [row] = await recordExternalSessionEventQuery.run(
          {
            externalSessionId: args.externalSessionId,
            type: args.type,
            eventType: `step.emit:${args.type}`,
            data: args.data,
          },
          db
        )
        const result = requireRow(row, "Failed to record external session event")

        if (result.runId) {
          await notifyRunEvent(result.runId)
        }

        return {
          status:
            result.status === "recorded" ||
            result.status === "missing" ||
            result.status === "stale"
              ? result.status
              : "stale",
          runId: result.runId,
          stepKey: result.stepKey,
          attemptId: result.attemptId,
          eventId: result.eventId === null ? null : Number(result.eventId),
        }
      }
    )

  const recordExternalHeartbeat = async (args: {
    externalSessionId: string
    leaseMs: number
    payload: JsonObject
  }) =>
    withStoreSpan(
      {
        name: "record_external_heartbeat",
        attributes: {
          "hippo.operation": "store.record_external_heartbeat",
          "workflow.external_session.id": args.externalSessionId,
        },
      },
      async () => {
        const [row] = await recordExternalHeartbeatQuery.run(args, db)
        const result = requireRow(row, "Failed to record external heartbeat")

        if (result.runId) {
          await notifyRunEvent(result.runId)
        }

        return {
          status:
            result.status === "recorded" ||
            result.status === "missing" ||
            result.status === "stale"
              ? result.status
              : "stale",
          runId: result.runId,
          stepKey: result.stepKey,
          attemptId: result.attemptId,
        }
      }
    )

  const listOpenExternalSessions = async (runId: string) =>
    withStoreSpan(
      {
        name: "list_open_external_sessions",
        attributes: {
          "hippo.operation": "store.list_open_external_sessions",
          "workflow.run.id": runId,
        },
      },
      async () => {
        const rows = await listOpenExternalSessionsQuery.run({ runId }, db)
        return rows.map((row) => ({
          stepKey: row.stepKey,
          externalSessionId: row.externalSessionId,
          externalSessionKind: row.externalSessionKind,
        }))
      }
    )

  const settleFanOutParent = async (args: {
    wait: WorkflowWaitRecord
    childRun: WorkflowRunRecord | null
    status: "resumed" | "expired"
  }) =>
    withTransaction(db, async (client) => {
      const waitRows = await listStepWaitsQuery.run(
        {
          runId: args.wait.runId,
          stepKey: args.wait.stepKey,
        },
        client
      )
      const waits = waitRows.map(mapWait)
      const matchingWait = waits.find((wait) => wait.id === args.wait.id) ?? args.wait

      if (!isFanOutWaitPayload(matchingWait.payload)) {
        return false
      }

      if (matchingWait.status === "open") {
        await updateWaitStatusQuery.run(
          {
            waitId: matchingWait.id,
            status: args.status,
            resumePayload:
              args.status === "resumed" && args.childRun
                ? {
                    childRunId: args.childRun.id,
                    childStatus: args.childRun.status,
                  }
                : args.status === "expired"
                  ? {
                      childRunId: matchingWait.payload.childRunId,
                      childStatus: "timed_out",
                    }
                  : null,
          },
          client
        )
      }

      const childRows = await listChildRunsQuery.run(
        { parentRunId: args.wait.runId },
        client
      )
      const childRuns = childRows
        .map(mapRun)
        .filter((run) => run.parentStepKey === args.wait.stepKey)
      const currentWaitRows = await listStepWaitsQuery.run(
        {
          runId: args.wait.runId,
          stepKey: args.wait.stepKey,
        },
        client
      )
      const currentWaits = currentWaitRows.map(mapWait)
      const fanOutPayload = getFanOutWaitPayload(currentWaits)

      if (!fanOutPayload) {
        return false
      }

      const joinStateBeforeCancel = getFanOutJoinState({
        childRuns,
        waits: currentWaits,
      })

      if (fanOutPayload.failureMode === "fail-fast" && joinStateBeforeCancel.hasFailure) {
        const waitsByChildRunId = groupFanOutWaitsByChildRunId(currentWaits)

        for (const childRun of childRuns) {
          if (terminalRunStatuses.has(childRun.status)) {
            continue
          }

          const [canceledRow] = await requestCancelRunQuery.run(
            {
              runId: childRun.id,
              mode: "hard",
              eventType: "run.canceled",
              eventPayload: { reason: "Fan-out child failed fast" },
            },
            client
          )
          const canceledRun = canceledRow ? mapRun(canceledRow) : childRun
          const siblingWait = waitsByChildRunId.get(canceledRun.id)

          if (siblingWait?.status === "open") {
            await updateWaitStatusQuery.run(
              {
                waitId: siblingWait.id,
                status: "resumed",
                resumePayload: {
                  childRunId: canceledRun.id,
                  childStatus: canceledRun.status,
                },
              },
              client
            )
          }
        }
      }

      const finalWaitRows = await listStepWaitsQuery.run(
        {
          runId: args.wait.runId,
          stepKey: args.wait.stepKey,
        },
        client
      )
      const finalWaits = finalWaitRows.map(mapWait)
      const finalChildRows = await listChildRunsQuery.run(
        { parentRunId: args.wait.runId },
        client
      )
      const finalChildRuns = finalChildRows
        .map(mapRun)
        .filter((run) => run.parentStepKey === args.wait.stepKey)
      const joinState = getFanOutJoinState({
        childRuns: finalChildRuns,
        waits: finalWaits,
      })

      if (!joinState.ready) {
        return false
      }

      const [queuedRow] = await queueWaitingRunQuery.run(
        {
          runId: args.wait.runId,
          stepKey: args.wait.stepKey,
          eventType: "child.completed",
          eventPayload: {
            fanOut: true,
            childCount: joinState.childCount,
            terminalCount: joinState.terminalCount,
            successfulCount: joinState.successfulCount,
          },
        },
        client
      )

      if (!queuedRow) {
        return false
      }

      await notifyRunnable()
      await notifyRunEvent(queuedRow.id)
      return true
    })

  const wakeParentForChild = async (childRun: WorkflowRunRecord) => {
    if (!childRun.parentRunId || !childRun.parentStepKey) {
      return false
    }

    const [fanOutWaitRow] = await getFanOutWaitByChildRunIdQuery.run(
      {
        childRunId: childRun.id,
      },
      db
    )

    if (!fanOutWaitRow) {
      const correlationKey = `child:${childRun.parentRunId}:${childRun.parentStepKey}`
      const result = await resumeWait({
        correlationKey,
        payload: {
          childRunId: childRun.id,
          childStatus: childRun.status,
        },
        resume: async (run, wait) => ({
          nextStepKey: wait.stepKey,
          context: run.context,
          output: {
            childRunId: childRun.id,
            childStatus: childRun.status,
          },
        }),
      })

      return result.status === "resumed"
    }

    return settleFanOutParent({
      wait: mapWait(fanOutWaitRow),
      childRun,
      status: "resumed",
    })
  }

  const expireOpenWaits = async (args: { limit: number }) => {
    return withStoreSpan(
      {
        name: "expire_open_waits",
        attributes: {
          "hippo.operation": "store.expire_open_waits",
          "workflow.recovery.limit": args.limit,
        },
      },
      async () => {
        const rows = await (
          expireOpenWaitsQuery as {
            run: (params: { limit: number }, executor: Database) => Promise<
              Array<{
                id: string
                runId: string
                stepKey: string
                correlationKey: string
                payload: JsonValue
                expiresAt: Date | null
              }>
            >
          }
        ).run(args, db)
        let expiredCount = 0

        for (const row of rows) {
          expiredCount += 1

          await updateWaitStatusQuery.run(
            {
              waitId: row.id,
              status: "expired",
              resumePayload: null,
            },
            db
          )

          if (isHumanTaskWaitPayload(row.payload)) {
            const [queuedRow] = await completeExpiredWaitTransitionQuery.run(
              {
                waitId: row.id,
                runId: row.runId,
                stepKey: row.stepKey,
                nextStepKey: row.payload.timeout.nextStepKey,
                context: row.payload.timeout.context,
                output: row.payload.timeout.output,
                eventType: "wait.expired",
                eventPayload: {
                  nextStepKey: row.payload.timeout.nextStepKey,
                },
              },
              db
            )

            if (queuedRow) {
              const queuedRun = mapRun(queuedRow)
              await notifyRunnable()
              await notifyRunEvent(queuedRun.id)
            }
            continue
          }

          if (!isFanOutWaitPayload(row.payload)) {
            const [failedRow] = await (
              failExpiredWaitRunQuery as {
                run: (params: { runId: string; stepKey: string }, executor: Database) => Promise<
                  Array<{ runId: string }>
                >
              }
            ).run(
              {
                runId: row.runId,
                stepKey: row.stepKey,
              },
              db
            )

            if (failedRow) {
              await notifyRunEvent(failedRow.runId)
            }
            continue
          }

          const existingChildRun = await self.getRun(row.payload.childRunId)
          const childRun =
            existingChildRun && !terminalRunStatuses.has(existingChildRun.status)
              ? await self.requestCancelRun({
                  runId: row.payload.childRunId,
                  mode: "hard",
                  reason: "Fan-out child timed out",
                })
              : existingChildRun

          await settleFanOutParent({
            wait: {
              id: row.id,
              runId: row.runId,
              stepKey: row.stepKey,
              correlationKey: row.correlationKey,
              status: "expired",
              payload: row.payload,
              resumePayload: null,
              resumeOutput: null,
              expiresAt: row.expiresAt ?? null,
              createdAt: new Date(),
              updatedAt: new Date(),
              resumedAt: null,
              externalSessionId: null,
              externalSessionKind: null,
            },
            childRun,
            status: "expired",
          })
        }

        return expiredCount
      }
    )
  }

  return {
    countOpenWaits,
    listStepWaits,
    openWait,
    openFanOutWaits,
    resumeWait,
    resumeExternalSession,
    recordExternalSessionEvent,
    recordExternalHeartbeat,
    listOpenExternalSessions,
    settleFanOutParent,
    wakeParentForChild,
    expireOpenWaits,
  }
}
