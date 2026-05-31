import { Pool, type PoolClient } from "pg"

import type { HippoConfig } from "./config.js"

export const createDatabase = (config: HippoConfig) =>
  new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
  })

export type Database = ReturnType<typeof createDatabase>

export const withTransaction = async <T>(
  db: Database,
  run: (client: PoolClient) => Promise<T>
) => {
  const client = await db.connect()

  try {
    await client.query("BEGIN")
    const result = await run(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
