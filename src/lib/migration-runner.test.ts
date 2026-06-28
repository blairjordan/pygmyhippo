import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import { runMigrations } from "./migration-runner.js"

const testDatabaseUrl = process.env.HIPPO_PG_TEST_URL
const { Client } = pg

describe.skipIf(!testDatabaseUrl)("migration runner postgres integration", () => {
  const databaseName = `hippo_mig_test_${randomUUID().replaceAll("-", "_")}`
  const baseUrl = new URL(
    testDatabaseUrl ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres"
  )
  const adminUrl = new URL(baseUrl.toString())
  adminUrl.pathname = "/postgres"

  let adminClient: pg.Client
  const connectionUrl = new URL(baseUrl.toString())
  connectionUrl.pathname = `/${databaseName}`

  beforeAll(async () => {
    adminClient = new Client({ connectionString: adminUrl.toString() })
    await adminClient.connect()
    await adminClient.query(`CREATE DATABASE ${databaseName}`)
  })

  afterAll(async () => {
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS ${databaseName}`)
    } finally {
      await adminClient.end()
    }
  })

  it("successfully applies all migrations programmatically", async () => {
    const url = connectionUrl.toString()

    // 1. Run migrations first time (applies all)
    await runMigrations(url)

    // 2. Connect to database to verify tables exist
    const client = new Client({ connectionString: url })
    await client.connect()

    try {
      // Verify schema_migrations table exists and has versions
      const { rows: migrationRows } = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations"
      )
      expect(migrationRows.length).toBeGreaterThan(0)

      // Verify workflow_runs table exists
      const { rows: runTables } = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'workflow_runs'"
      )
      expect(runTables[0]?.table_name).toBe("workflow_runs")
    } finally {
      await client.end()
    }

    // 3. Run migrations second time (idempotency check, should be a no-op)
    await expect(runMigrations(url)).resolves.not.toThrow()
  })
})
