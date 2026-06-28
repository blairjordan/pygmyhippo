import pg from "pg"
import { migrations } from "./migrations.js"

const { Client } = pg

export const runMigrations = async (databaseUrl: string): Promise<void> => {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY
      );
    `)

    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations"
    )
    const appliedVersions = new Set(rows.map((row) => row.version))

    for (const migration of migrations) {
      const match = migration.name.match(/^(\d+)_/)
      if (!match) {
        continue
      }
      const version = match[1]
      if (version === undefined) {
        continue
      }

      if (appliedVersions.has(version)) {
        continue
      }

      const [upBlock] = migration.sql.split("-- migrate:down")
      const sqlToRun = (upBlock ?? "").replace("-- migrate:up", "").trim()

      await client.query("BEGIN")
      try {
        if (sqlToRun.length > 0) {
          await client.query(sqlToRun)
        }
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
          version,
        ])
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      }
    }
  } finally {
    await client.end()
  }
}
