import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client"

export const createMetrics = () => {
  const registry = new Registry()

  collectDefaultMetrics({ register: registry })

  const runsStarted = new Counter({
    name: "hippo_runs_started_total",
    help: "Workflow runs started",
    registers: [registry],
    labelNames: ["workflow"] as const,
  })

  const runsCompleted = new Counter({
    name: "hippo_runs_completed_total",
    help: "Workflow runs completed",
    registers: [registry],
    labelNames: ["workflow"] as const,
  })

  const runsFailed = new Counter({
    name: "hippo_runs_failed_total",
    help: "Workflow runs failed",
    registers: [registry],
    labelNames: ["workflow", "step"] as const,
  })

  const stepAttempts = new Counter({
    name: "hippo_step_attempts_total",
    help: "Workflow step attempts",
    registers: [registry],
    labelNames: ["workflow", "step", "status"] as const,
  })

  const waitOpens = new Gauge({
    name: "hippo_waits_open",
    help: "Open callback waits",
    registers: [registry],
  })

  const claims = new Counter({
    name: "hippo_claims_total",
    help: "Claimed runnable workflow runs",
    registers: [registry],
  })

  return {
    registry,
    runsStarted,
    runsCompleted,
    runsFailed,
    stepAttempts,
    waitOpens,
    claims,
  }
}

export type HippoMetrics = ReturnType<typeof createMetrics>
