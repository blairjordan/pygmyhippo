import type { PoolClient } from "pg"
import type { StoreContext } from "./context.js"
import type { Database } from "../db.js"
import type { JsonValue } from "../../types/json.js"
import {
  getKv as getKvQuery,
  setKv as setKvQuery,
  deleteKv as deleteKvQuery,
} from "../../queries/workflow-store.queries.js"

export const createKVMethods = (ctx: StoreContext) => {
  const { db, withStoreSpan } = ctx

  const getRunKV = async (
    runId: string,
    key: string,
    executor?: Database | PoolClient
  ) =>
    withStoreSpan(
      {
        name: "get_run_kv",
        attributes: {
          "hippo.operation": "store.get_run_kv",
          "workflow.run.id": runId,
          "workflow.kv.key": key,
        },
      },
      async () => {
        const rows = await getKvQuery.run({ runId, key }, executor ?? db)
        return rows[0]?.value ?? null
      }
    )

  const setRunKV = async (
    runId: string,
    key: string,
    value: JsonValue,
    executor?: Database | PoolClient
  ) =>
    withStoreSpan(
      {
        name: "set_run_kv",
        attributes: {
          "hippo.operation": "store.set_run_kv",
          "workflow.run.id": runId,
          "workflow.kv.key": key,
        },
      },
      async () => {
        const serializedValue = JSON.stringify(value)
        await setKvQuery.run({ runId, key, value: serializedValue }, executor ?? db)
      }
    )

  const deleteRunKV = async (
    runId: string,
    key: string,
    executor?: Database | PoolClient
  ) =>
    withStoreSpan(
      {
        name: "delete_run_kv",
        attributes: {
          "hippo.operation": "store.delete_run_kv",
          "workflow.run.id": runId,
          "workflow.kv.key": key,
        },
      },
      async () => {
        await deleteKvQuery.run({ runId, key }, executor ?? db)
      }
    )

  return {
    getRunKV,
    setRunKV,
    deleteRunKV,
  }
}
