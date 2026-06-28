import { Command } from "commander"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

import { runMigrations } from "./lib/migration-runner.js"
import { renderWorkflowAsMermaid } from "./lib/workflow-definition.js"
import { loadWorkflowDefinitions } from "./lib/workflow-loader.js"
import { createApp } from "./app.js"
import {
  createApiAuthenticator,
  createCallbackAuthenticator,
} from "./lib/auth.js"
import { getConfig } from "./lib/config.js"
import { createDatabase } from "./lib/db.js"
import { createMetrics } from "./lib/metrics.js"
import { createWorkflowNotifier } from "./lib/notifier.js"
import { startOutboxLoop } from "./lib/outbox.js"
import { startRecoveryLoop } from "./lib/recovery.js"
import { startScheduleLoop } from "./lib/scheduler.js"
import { createHippoTracer } from "./lib/tracing.js"
import { startWorkerLoop } from "./lib/worker.js"
import { createWorkflowEngine } from "./lib/workflow-engine.js"
import { createWorkflowStore } from "./lib/workflow-store.js"

const program = new Command()
program
  .name("hippo")
  .description("Hippo command-line interface")
  .version("0.1.0")

// Command: migrate
program
  .command("migrate")
  .description("Apply database migrations to Postgres")
  .option("--database-url <url>", "PostgreSQL connection URL")
  .action(async (options) => {
    const databaseUrl = options.databaseUrl || process.env.DATABASE_URL
    if (!databaseUrl) {
      console.error("Error: Database URL is required. Provide --database-url or set DATABASE_URL.")
      process.exit(1)
    }
    try {
      await runMigrations(databaseUrl)
      console.log("Migrations applied successfully.")
    } catch (error) {
      console.error("Migration failed:", error)
      process.exit(1)
    }
  })

// Command: render
program
  .command("render <workflowName>")
  .description("Render a workflow definition as Mermaid diagram")
  .option("--workflows <path>", "Path to the workflows index file", "./dist/src/workflows/index.js")
  .action(async (workflowName, options) => {
    const workflowsPath = path.resolve(process.cwd(), options.workflows)
    const moduleUrl = pathToFileURL(workflowsPath)
    try {
      const definitions = await loadWorkflowDefinitions(moduleUrl)
      const definition = definitions.find((d) => d.name === workflowName)
      if (!definition) {
        console.error(`Error: Workflow "${workflowName}" not found in ${workflowsPath}`)
        process.exit(1)
      }
      console.log(renderWorkflowAsMermaid(definition))
    } catch (error) {
      console.error("Failed to render workflow:", error)
      process.exit(1)
    }
  })

// Shared runner helpers
const parseTaskQueues = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

const bootstrapEngine = async (workflowsPath: string) => {
  const config = getConfig()
  const moduleUrl = pathToFileURL(path.resolve(process.cwd(), workflowsPath))
  const workflowDefinitions = await loadWorkflowDefinitions(moduleUrl)
  const sql = createDatabase(config)
  const metrics = createMetrics()
  const tracer = createHippoTracer()
  const notifier = createWorkflowNotifier(config)
  const store = createWorkflowStore(sql, {
    notifyRunnable: () => notifier.notifyRunnable(),
    notifyRunEvent: (runId) => notifier.notifyRunEvent(runId),
    tracer,
  })
  const engine = createWorkflowEngine({
    definitions: workflowDefinitions,
    metrics,
    store,
    tracer,
  })
  return { config, sql, metrics, tracer, notifier, store, engine }
}

// Command: worker
program
  .command("worker")
  .description("Start background execution loops (worker, scheduler, recovery, outbox)")
  .option("--workflows <path>", "Path to the workflows index file", "./dist/src/workflows/index.js")
  .action(async (options) => {
    try {
      const { config, sql, metrics, tracer, notifier, store, engine } = await bootstrapEngine(options.workflows)

      console.log("Starting Hippo worker loops...")
      const stopWorker = startWorkerLoop({
        engine,
        workerId: config.HIPPO_WORKER_ID,
        taskQueues: parseTaskQueues(config.HIPPO_TASK_QUEUES),
        pollIntervalMs: config.HIPPO_POLL_INTERVAL_MS,
        leaseMs: config.HIPPO_LEASE_MS,
        listenForWakeups: (onWake) => notifier.listen(() => onWake()),
        onError: (error) => console.error("Worker error:", error),
        tracer,
      })

      const stopRecovery = startRecoveryLoop({
        intervalMs: config.HIPPO_RECOVERY_INTERVAL_MS,
        limit: 100,
        metrics,
        onError: (error) => console.error("Recovery error:", error),
        store,
        tracer,
      })

      const stopScheduler = startScheduleLoop({
        engine,
        intervalMs: config.HIPPO_SCHEDULE_INTERVAL_MS,
        limit: 100,
        onError: (error) => console.error("Scheduler error:", error),
        store,
        tracer,
      })

      const stopOutbox = startOutboxLoop({
        handlers: {},
        intervalMs: config.HIPPO_OUTBOX_INTERVAL_MS,
        limit: 100,
        onError: (error, record) => console.error("Outbox error:", error, record),
        store,
        tracer,
      })

      const shutdown = async () => {
        console.log("Shutting down worker loops...")
        await stopWorker()
        await stopRecovery()
        await stopScheduler()
        await stopOutbox()
        await sql.end()
        process.exit(0)
      }

      process.on("SIGINT", () => void shutdown())
      process.on("SIGTERM", () => void shutdown())
    } catch (error) {
      console.error("Worker bootstrap failed:", error)
      process.exit(1)
    }
  })

// Command: server
program
  .command("server")
  .description("Start the API server, dashboard, and background loops")
  .option("--workflows <path>", "Path to the workflows index file", "./dist/src/workflows/index.js")
  .action(async (options) => {
    try {
      const { config, sql, metrics, tracer, notifier, store, engine } = await bootstrapEngine(options.workflows)

      console.log("Starting Hippo API server & worker loops...")
      const auth = {
        verifyApiRequest: createApiAuthenticator(config.HIPPO_API_TOKEN),
        verifyCallbackRequest: createCallbackAuthenticator({
          secret: config.HIPPO_CALLBACK_SECRET,
          toleranceSeconds: config.HIPPO_CALLBACK_TOLERANCE_SECONDS,
        }),
      }

      const app = createApp({
        auth,
        engine,
        listenForNotifications: notifier.listen,
        metrics,
        store,
        tracer,
      })

      const stopWorker = startWorkerLoop({
        engine,
        workerId: config.HIPPO_WORKER_ID,
        taskQueues: parseTaskQueues(config.HIPPO_TASK_QUEUES),
        pollIntervalMs: config.HIPPO_POLL_INTERVAL_MS,
        leaseMs: config.HIPPO_LEASE_MS,
        listenForWakeups: (onWake) => notifier.listen(() => onWake()),
        onError: (error) => app.log.error(error),
        tracer,
      })

      const stopRecovery = startRecoveryLoop({
        intervalMs: config.HIPPO_RECOVERY_INTERVAL_MS,
        limit: 100,
        metrics,
        onError: (error) => app.log.error(error),
        store,
        tracer,
      })

      const stopScheduler = startScheduleLoop({
        engine,
        intervalMs: config.HIPPO_SCHEDULE_INTERVAL_MS,
        limit: 100,
        onError: (error) => app.log.error(error),
        store,
        tracer,
      })

      const stopOutbox = startOutboxLoop({
        handlers: {},
        intervalMs: config.HIPPO_OUTBOX_INTERVAL_MS,
        limit: 100,
        onError: (error, record) => app.log.error({ error, record }),
        store,
        tracer,
      })

      const shutdown = async () => {
        console.log("Shutting down Hippo API server & worker loops...")
        await stopWorker()
        await stopRecovery()
        await stopScheduler()
        await stopOutbox()
        await app.close()
        await sql.end()
        process.exit(0)
      }

      process.on("SIGINT", () => void shutdown())
      process.on("SIGTERM", () => void shutdown())

      await app.listen({
        host: config.HIPPO_HOST,
        port: config.HIPPO_PORT,
      })
    } catch (error) {
      console.error("Server bootstrap failed:", error)
      process.exit(1)
    }
  })

program.parse(process.argv)
