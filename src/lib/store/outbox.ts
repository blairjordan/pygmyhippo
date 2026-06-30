import type { PoolClient } from "pg"
import type { StoreContext } from "./context.js"
import type { JsonObject } from "../../types/json.js"
import {
  insertOutbox as insertOutboxQuery,
  claimOutboxMessages as claimOutboxMessagesQuery,
  markOutboxDelivered as markOutboxDeliveredQuery,
} from "../../queries/workflow-store.queries.js"
import { mapOutbox } from "./mappers.js"
import { withTransaction } from "../db.js"

export const createOutboxMethods = (ctx: StoreContext) => {
  const { db, withStoreSpan } = ctx

  const enqueueOutbox = async (args: {
    runId?: string | null
    topic: string
    payload: JsonObject
    availableAt?: Date
    client?: PoolClient
  }) => {
    await insertOutboxQuery.run(
      {
        runId: args.runId ?? null,
        topic: args.topic,
        payload: args.payload,
        availableAt: args.availableAt ?? null,
      },
      args.client ?? db
    )
  }

  const claimOutboxMessages = async (limit: number) =>
    withStoreSpan(
      {
        name: "claim_outbox_messages",
        attributes: {
          "hippo.operation": "store.claim_outbox_messages",
          "workflow.outbox.limit": limit,
        },
      },
      () =>
        withTransaction(db, async (client) => {
          const rows = await claimOutboxMessagesQuery.run({ limit }, client)

          return rows.map(mapOutbox)
        })
    )

  const markOutboxDelivered = async (outboxId: string) => {
    return withStoreSpan(
      {
        name: "mark_outbox_delivered",
        attributes: {
          "hippo.operation": "store.mark_outbox_delivered",
          "workflow.outbox.id": outboxId,
        },
      },
      async () => {
        const rows = await markOutboxDeliveredQuery.run({ outboxId }, db)

        return rows.length > 0
      }
    )
  }

  return {
    enqueueOutbox,
    claimOutboxMessages,
    markOutboxDelivered,
  }
}
