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
import {
  loadWorkflowDefinitions,
  startWorkflowDevReloader,
  workflowModulePath,
} from "./lib/workflow-loader.js"
import { startWorkerLoop } from "./lib/worker.js"
import { createWorkflowEngine } from "./lib/workflow-engine.js"
import { createWorkflowStore } from "./lib/workflow-store.js"

const parseTaskQueues = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

const main = async () => {
  const config = getConfig()
  const workflowDefinitions =
    await loadWorkflowDefinitions(workflowModulePath())
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
    externalHeartbeatLeaseMs: config.HIPPO_LEASE_MS,
    listenForNotifications: notifier.listen,
    metrics,
    store,
    tracer,
  })
  const stopWorkflowReload =
    config.HIPPO_ENV === "dev"
      ? await startWorkflowDevReloader({
          engine,
          logger: app.log,
          modulePath: workflowModulePath(),
        })
      : async () => undefined

  const stopWorker = startWorkerLoop({
    engine,
    workerId: config.HIPPO_WORKER_ID,
    taskQueues: parseTaskQueues(config.HIPPO_TASK_QUEUES),
    pollIntervalMs: config.HIPPO_POLL_INTERVAL_MS,
    leaseMs: config.HIPPO_LEASE_MS,
    listenForWakeups: (onWake) => notifier.listen(() => onWake()),
    onError: (error) => {
      app.log.error(error)
    },
    tracer,
  })
  const stopRecovery = startRecoveryLoop({
    intervalMs: config.HIPPO_RECOVERY_INTERVAL_MS,
    limit: 100,
    metrics,
    onError: (error) => {
      app.log.error(error)
    },
    store,
    tracer,
  })
  const stopScheduler = startScheduleLoop({
    engine,
    intervalMs: config.HIPPO_SCHEDULE_INTERVAL_MS,
    limit: 100,
    onError: (error) => {
      app.log.error(error)
    },
    store,
    tracer,
  })
  const stopOutbox = startOutboxLoop({
    handlers: {},
    intervalMs: config.HIPPO_OUTBOX_INTERVAL_MS,
    limit: 100,
    onError: (error, record) => {
      app.log.error({ error, record })
    },
    store,
    tracer,
  })

  const shutdown = async () => {
    await stopWorkflowReload()
    await stopWorker()
    await stopRecovery()
    await stopScheduler()
    await stopOutbox()
    await app.close()
    await sql.end()
  }

  process.on("SIGINT", () => {
    void shutdown()
  })

  process.on("SIGTERM", () => {
    void shutdown()
  })

  await app.listen({
    host: config.HIPPO_HOST,
    port: config.HIPPO_PORT,
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
