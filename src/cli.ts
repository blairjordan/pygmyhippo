import { Command } from "commander"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

import { createApp } from "./app.js"
import {
  createApiAuthenticator,
  createCallbackAuthenticator,
} from "./lib/auth.js"
import {
  closeSql,
  createDefaultCliDeps,
  defaultWorkflowPath,
  parseTaskQueues,
  resolveWorkflowModuleUrl,
  runStoreCommand,
  type CliDeps,
} from "./lib/cli-deps.js"
import { startOutboxLoop } from "./lib/outbox.js"
import { startRecoveryLoop } from "./lib/recovery.js"
import { startScheduleLoop } from "./lib/scheduler.js"
import { startWorkerLoop } from "./lib/worker.js"
import type {
  WorkflowRunStatus,
} from "./types/workflow.js"

export const createHippoCli = (inputDeps: Partial<CliDeps> = {}) => {
  const deps = {
    ...createDefaultCliDeps(),
    ...inputDeps,
  } satisfies CliDeps
  const program = new Command()

  program
    .name("hippo")
    .description("Hippo command-line interface")
    .version("0.1.0")

  program
    .command("migrate")
    .description("Apply database migrations to Postgres")
    .option("--database-url <url>", "PostgreSQL connection URL")
    .action(async (options: { databaseUrl?: string }) => {
      const databaseUrl = options.databaseUrl ?? deps.env.DATABASE_URL

      if (!databaseUrl) {
        deps.stderr.error(
          "Error: Database URL is required. Provide --database-url or set DATABASE_URL."
        )
        deps.exit(1)
        throw new Error("unreachable")
      }

      try {
        await deps.runMigrations(databaseUrl)
        deps.stdout.log("Migrations applied successfully.")
      } catch (error) {
        deps.stderr.error("Migration failed:", error)
        deps.exit(1)
      }
    })

  const addRenderCommand = (command: Command) => {
    command
      .command("render <workflowName>")
      .description("Render a workflow definition as Mermaid diagram")
      .option(
        "--workflows <path>",
        "Path to the workflows index file",
        defaultWorkflowPath
      )
      .action(
        async (workflowName: string, options: { workflows?: string }) => {
          const workflowsPath = path.resolve(
            deps.cwd(),
            options.workflows ?? defaultWorkflowPath
          )

          try {
            const definitions = await deps.loadWorkflowDefinitions(
              pathToFileURL(workflowsPath)
            )
            const definition = definitions.find(
              (candidate) => candidate.name === workflowName
            )

            if (!definition) {
              deps.stderr.error(
                `Error: Workflow "${workflowName}" not found in ${workflowsPath}`
              )
              deps.exit(1)
              throw new Error("unreachable")
            }

            deps.stdout.log(deps.renderWorkflowAsMermaid(definition))
          } catch (error) {
            deps.stderr.error("Failed to render workflow:", error)
            deps.exit(1)
          }
        }
      )
  }

  addRenderCommand(program)

  program
    .command("worker")
    .description("Start background execution loops (worker, scheduler, recovery, outbox)")
    .option(
      "--workflows <path>",
      "Path to the workflows index file",
      defaultWorkflowPath
    )
    .action(async (options: { workflows?: string }) => {
      try {
        const runtime = await deps.bootstrapEngine(
          options.workflows ?? defaultWorkflowPath
        )

        deps.stdout.log("Starting Hippo worker loops...")
        const stopWorker = startWorkerLoop({
          engine: runtime.engine,
          workerId: runtime.config.HIPPO_WORKER_ID,
          taskQueues: parseTaskQueues(runtime.config.HIPPO_TASK_QUEUES),
          pollIntervalMs: runtime.config.HIPPO_POLL_INTERVAL_MS,
          leaseMs: runtime.config.HIPPO_LEASE_MS,
          listenForWakeups: (onWake) => runtime.notifier.listen(() => onWake()),
          onError: (error) => deps.stderr.error("Worker error:", error),
          tracer: runtime.tracer,
        })
        const stopRecovery = startRecoveryLoop({
          intervalMs: runtime.config.HIPPO_RECOVERY_INTERVAL_MS,
          limit: 100,
          metrics: runtime.metrics,
          onError: (error) => deps.stderr.error("Recovery error:", error),
          store: runtime.store,
          tracer: runtime.tracer,
        })
        const stopScheduler = startScheduleLoop({
          engine: runtime.engine,
          intervalMs: runtime.config.HIPPO_SCHEDULE_INTERVAL_MS,
          limit: 100,
          onError: (error) => deps.stderr.error("Scheduler error:", error),
          store: runtime.store,
          tracer: runtime.tracer,
        })
        const stopOutbox = startOutboxLoop({
          handlers: {},
          intervalMs: runtime.config.HIPPO_OUTBOX_INTERVAL_MS,
          limit: 100,
          onError: (error, record) => deps.stderr.error("Outbox error:", error, record),
          store: runtime.store,
          tracer: runtime.tracer,
        })
        const shutdown = async () => {
          deps.stdout.log("Shutting down worker loops...")
          await stopWorker()
          await stopRecovery()
          await stopScheduler()
          await stopOutbox()
          await closeSql(runtime.sql)
          deps.exit(0)
        }

        process.on("SIGINT", () => void shutdown())
        process.on("SIGTERM", () => void shutdown())
      } catch (error) {
        deps.stderr.error("Worker bootstrap failed:", error)
        deps.exit(1)
      }
    })

  program
    .command("server")
    .description("Start the API server, dashboard, and background loops")
    .option(
      "--workflows <path>",
      "Path to the workflows index file",
      defaultWorkflowPath
    )
    .action(async (options: { workflows?: string }) => {
      try {
        const runtime = await deps.bootstrapEngine(
          options.workflows ?? defaultWorkflowPath
        )
        deps.stdout.log("Starting Hippo API server & worker loops...")

        const app = createApp({
          auth: {
            verifyApiRequest: createApiAuthenticator(runtime.config.HIPPO_API_TOKEN),
            verifyCallbackRequest: createCallbackAuthenticator({
              secret: runtime.config.HIPPO_CALLBACK_SECRET,
              toleranceSeconds: runtime.config.HIPPO_CALLBACK_TOLERANCE_SECONDS,
            }),
          },
          engine: runtime.engine,
          externalHeartbeatLeaseMs: runtime.config.HIPPO_LEASE_MS,
          listenForNotifications: runtime.notifier.listen,
          metrics: runtime.metrics,
          store: runtime.store,
          tracer: runtime.tracer,
        })
        const stopWorker = startWorkerLoop({
          engine: runtime.engine,
          workerId: runtime.config.HIPPO_WORKER_ID,
          taskQueues: parseTaskQueues(runtime.config.HIPPO_TASK_QUEUES),
          pollIntervalMs: runtime.config.HIPPO_POLL_INTERVAL_MS,
          leaseMs: runtime.config.HIPPO_LEASE_MS,
          listenForWakeups: (onWake) => runtime.notifier.listen(() => onWake()),
          onError: (error) => app.log.error(error),
          tracer: runtime.tracer,
        })
        const stopRecovery = startRecoveryLoop({
          intervalMs: runtime.config.HIPPO_RECOVERY_INTERVAL_MS,
          limit: 100,
          metrics: runtime.metrics,
          onError: (error) => app.log.error(error),
          store: runtime.store,
          tracer: runtime.tracer,
        })
        const stopScheduler = startScheduleLoop({
          engine: runtime.engine,
          intervalMs: runtime.config.HIPPO_SCHEDULE_INTERVAL_MS,
          limit: 100,
          onError: (error) => app.log.error(error),
          store: runtime.store,
          tracer: runtime.tracer,
        })
        const stopOutbox = startOutboxLoop({
          handlers: {},
          intervalMs: runtime.config.HIPPO_OUTBOX_INTERVAL_MS,
          limit: 100,
          onError: (error, record) => app.log.error({ error, record }),
          store: runtime.store,
          tracer: runtime.tracer,
        })
        const shutdown = async () => {
          deps.stdout.log("Shutting down Hippo API server & worker loops...")
          await stopWorker()
          await stopRecovery()
          await stopScheduler()
          await stopOutbox()
          await app.close()
          await closeSql(runtime.sql)
          deps.exit(0)
        }

        process.on("SIGINT", () => void shutdown())
        process.on("SIGTERM", () => void shutdown())
        await app.listen({
          host: runtime.config.HIPPO_HOST,
          port: runtime.config.HIPPO_PORT,
        })
      } catch (error) {
        deps.stderr.error("Server bootstrap failed:", error)
        deps.exit(1)
      }
    })

  const runsCmd = program
    .command("runs")
    .description("Manage and query workflow runs")

  runsCmd
    .command("list")
    .alias("ls")
    .description("List workflow runs with optional filters")
    .option("--limit <number>", "Maximum number of runs to list", "50")
    .option("--status <status>", "Filter runs by status")
    .option("--workflow <name>", "Filter runs by workflow name")
    .option("--search <query>", "Search query for run ID, definition name or step key")
    .action(
      async (options: {
        limit: string
        status?: string
        workflow?: string
        search?: string
      }) => {
        try {
          await runStoreCommand(deps, async (store) => {
            const runs = await store.listRunsPaginated({
              limit: parseInt(options.limit, 10),
              ...(options.status
                ? { statuses: [options.status as WorkflowRunStatus] }
                : {}),
              ...(options.workflow ? { workflowName: options.workflow } : {}),
              ...(options.search ? { search: options.search } : {}),
            })

            if (runs.length === 0) {
              deps.stdout.log("No runs found.")
              return
            }

            deps.stdout.log(
              `${"RUN ID".padEnd(36)} | ${"WORKFLOW".padEnd(20)} | ${"STATUS".padEnd(10)} | ${"CURRENT STEP".padEnd(20)} | UPDATED AT`
            )
            deps.stdout.log("-".repeat(105))

            for (const run of runs) {
              deps.stdout.log(
                `${run.id} | ${run.definitionName.padEnd(20).slice(0, 20)} | ${run.status.padEnd(10)} | ${(run.currentStepKey ?? "done").padEnd(20).slice(0, 20)} | ${run.updatedAt.toLocaleString()}`
              )
            }
          })
        } catch (error) {
          deps.stderr.error("Failed to list runs:", error)
          deps.exit(1)
        }
      }
    )

  runsCmd
    .command("show <runId>")
    .description("Inspect a specific workflow run in detail")
    .action(async (runId: string) => {
      try {
        await runStoreCommand(deps, async (store) => {
          const run = await store.getRun(runId)

          if (!run) {
            deps.stderr.error(`Error: Run "${runId}" not found.`)
            deps.exit(1)
            throw new Error("unreachable")
          }

          deps.stdout.log("Run Details:")
          deps.stdout.log(`  ID:                 ${run.id}`)
          deps.stdout.log(`  Workflow:           ${run.definitionName} (v${run.definitionVersion})`)
          deps.stdout.log(`  Status:             ${run.status}`)
          deps.stdout.log(`  Task Queue:         ${run.taskQueue}`)
          deps.stdout.log(`  Priority:           ${run.priority}`)
          deps.stdout.log(`  Current Step:       ${run.currentStepKey ?? "Completed"}`)
          deps.stdout.log(`  Lease Owner:        ${run.leaseOwner ?? "None"}`)
          deps.stdout.log(`  Lease Expires:      ${run.leaseExpiresAt ? run.leaseExpiresAt.toLocaleString() : "N/A"}`)
          deps.stdout.log(`  Available At:       ${run.availableAt.toLocaleString()}`)
          deps.stdout.log(`  Created At:         ${run.createdAt.toLocaleString()}`)
          deps.stdout.log(`  Updated At:         ${run.updatedAt.toLocaleString()}`)

          if (run.completedAt) {
            deps.stdout.log(`  Completed At:       ${run.completedAt.toLocaleString()}`)
          }

          if (run.parentRunId) {
            deps.stdout.log(`  Parent Run ID:      ${run.parentRunId} (Step: ${run.parentStepKey})`)
          }

          if (run.traceContext) {
            deps.stdout.log(`  Trace Context:      ${run.traceContext}`)
          }

          deps.stdout.log("\nInput:")
          deps.stdout.log(JSON.stringify(run.input, null, 2))
          deps.stdout.log("\nContext:")
          deps.stdout.log(JSON.stringify(run.context, null, 2))

          if (run.result) {
            deps.stdout.log("\nResult:")
            deps.stdout.log(JSON.stringify(run.result, null, 2))
          }

          if (run.error) {
            deps.stdout.log("\nError:")
            deps.stdout.log(JSON.stringify(run.error, null, 2))
          }

          const attempts = await store.getRunAttempts(runId)

          if (attempts.length === 0) {
            return
          }

          deps.stdout.log("\nStep Attempts:")
          deps.stdout.log(
            `${"  STEP".padEnd(25)} | ${"KIND".padEnd(12)} | ${"ATTEMPT".padEnd(8)} | ${"STATUS".padEnd(10)} | COMPLETED AT`
          )
          deps.stdout.log(`  ${"-".repeat(70)}`)

          for (const attempt of attempts) {
            deps.stdout.log(
              `  ${attempt.stepKey.padEnd(23).slice(0, 23)} | ${attempt.kind.padEnd(10)} | ${String(attempt.attempt).padEnd(6)} | ${attempt.status.padEnd(8)} | ${attempt.completedAt ? attempt.completedAt.toLocaleString() : "in-progress"}`
            )
          }
        })
      } catch (error) {
        deps.stderr.error("Failed to inspect run:", error)
        deps.exit(1)
      }
    })

  runsCmd
    .command("cancel <runId>")
    .description("Request cancellation of a workflow run")
    .option("--mode <mode>", "Cancel mode: graceful or hard", "graceful")
    .action(async (runId: string, options: { mode: string }) => {
      try {
        await runStoreCommand(deps, async (store) => {
          const run = await store.getRun(runId)

          if (!run) {
            deps.stderr.error(`Error: Run "${runId}" not found.`)
            deps.exit(1)
          }

          const mode = options.mode === "hard" ? "hard" : "graceful"
          await store.requestCancelRun({ runId, mode })
          deps.stdout.log(`Cancellation request ('${mode}') submitted for run ${runId}.`)
        })
      } catch (error) {
        deps.stderr.error("Failed to cancel run:", error)
        deps.exit(1)
      }
    })

  const workflowsCmd = program
    .command("workflows")
    .description("Query and render workflows")

  workflowsCmd
    .command("list")
    .alias("ls")
    .description("List all loaded workflow definitions")
    .option(
      "--workflows <path>",
      "Path to the workflows index file",
      defaultWorkflowPath
    )
    .action(async (options: { workflows?: string }) => {
      try {
        const definitions = await deps.loadWorkflowDefinitions(
          resolveWorkflowModuleUrl({
            cwd: deps.cwd(),
            workflowsPath: options.workflows ?? defaultWorkflowPath,
          })
        )

        if (definitions.length === 0) {
          deps.stdout.log("No workflows registered.")
          return
        }

        deps.stdout.log("Registered Workflows:")

        for (const definition of definitions) {
          deps.stdout.log(
            `- ${definition.name} (version: ${definition.version})${definition.title ? `: ${definition.title}` : ""}`
          )
        }
      } catch (error) {
        deps.stderr.error("Failed to list workflows:", error)
        deps.exit(1)
      }
    })

  addRenderCommand(workflowsCmd)

  return program
}

export const runHippoCli = async (argv = process.argv) => {
  await createHippoCli().parseAsync(argv)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runHippoCli()
}
