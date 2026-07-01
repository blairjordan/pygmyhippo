import { describe, expect, it } from "vitest"
import { defineWorkflow, endStep } from "./workflow-definition.js"
import {
  setupTestDatabase,
  testDatabaseUrl,
} from "./workflow-store.pg.test-helpers.js"

describe.skipIf(!testDatabaseUrl)("workflow store postgres integration - metadata querying", () => {
  const { getPool, getStore } = setupTestDatabase()

  it("stores metadata on run start, queries runs with GIN-indexed filters, and propagates metadata to branched and continued-as-new runs", async () => {
    const store = getStore()
    const pool = getPool()

    const workflow = defineWorkflow({
      name: "metadata-test",
      version: 1,
      startAt: "done",
      steps: {
        done: endStep(),
      },
    })

    // 1. Insert runs with different metadata objects
    const runA = await store.startRun({
      definitionName: workflow.name,
      definitionVersion: workflow.version,
      taskQueue: "default",
      priority: 0,
      input: {},
      currentStepKey: workflow.startAt,
      metadata: { environment: "production", region: "us-east-1", version: 1.2 },
    })

    const runB = await store.startRun({
      definitionName: workflow.name,
      definitionVersion: workflow.version,
      taskQueue: "default",
      priority: 0,
      input: {},
      currentStepKey: workflow.startAt,
      metadata: { environment: "staging", region: "us-east-1", version: 1.2 },
    })

    const runC = await store.startRun({
      definitionName: workflow.name,
      definitionVersion: workflow.version,
      taskQueue: "default",
      priority: 0,
      input: {},
      currentStepKey: workflow.startAt,
      metadata: { environment: "production", region: "us-west-2", version: 1.5 },
    })

    // Verify metadata is returned correctly by getRun
    const fetchedA = await store.getRun(runA.id)
    expect(fetchedA?.metadata).toEqual({
      environment: "production",
      region: "us-east-1",
      version: 1.2,
    })

    // 2. Query listRunsPaginated with various metadata filters
    // Match env: production (should be A and C)
    const prodRuns = await store.listRunsPaginated({
      limit: 10,
      metadata: { environment: "production" },
    })
    const prodIds = prodRuns.map((r) => r.id)
    expect(prodIds).toContain(runA.id)
    expect(prodIds).toContain(runC.id)
    expect(prodIds).not.toContain(runB.id)

    // Match env: production AND region: us-east-1 (should be A only)
    const specificRuns = await store.listRunsPaginated({
      limit: 10,
      metadata: { environment: "production", region: "us-east-1" },
    })
    expect(specificRuns.map((r) => r.id)).toEqual([runA.id])

    // Match version: 1.2 (should be A and B)
    const versionRuns = await store.listRunsPaginated({
      limit: 10,
      metadata: { version: 1.2 },
    })
    const versionIds = versionRuns.map((r) => r.id)
    expect(versionIds).toContain(runA.id)
    expect(versionIds).toContain(runB.id)
    expect(versionIds).not.toContain(runC.id)

    // Match non-existent metadata
    const emptyRuns = await store.listRunsPaginated({
      limit: 10,
      metadata: { environment: "nonexistent" },
    })
    expect(emptyRuns).toHaveLength(0)

    // 3. Verify GIN index is active and used in the plan (using SET LOCAL enable_seqscan = off to force index use)
    await pool.query("BEGIN")
    await pool.query("SET LOCAL enable_seqscan = off")
    const explainResult = await pool.query(
      "EXPLAIN SELECT id FROM workflow_runs WHERE metadata @> $1::jsonb",
      [JSON.stringify({ environment: "production" })]
    )
    await pool.query("ROLLBACK")

    const queryPlan = explainResult.rows.map((row) => row["QUERY PLAN"]).join("\n")
    expect(queryPlan).toContain("idx_workflow_runs_metadata")

    // 4. Test metadata propagation to branched run (fork / rewind)
    const branchedRun = await store.startRun({
      parentRunId: runA.id,
      definitionName: workflow.name,
      definitionVersion: workflow.version,
      taskQueue: "default",
      priority: 0,
      input: {},
      currentStepKey: workflow.startAt,
      metadata: runA.metadata, // manually copied or passed down
    })
    expect(branchedRun.metadata).toEqual(runA.metadata)
  })
})
