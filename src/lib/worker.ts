import type { WorkflowEngine } from "./workflow-engine.js"

export const startWorkerLoop = (args: {
  engine: WorkflowEngine
  workerId: string
  pollIntervalMs: number
  leaseMs: number
}) => {
  let active = true

  const tick = async () => {
    if (!active) {
      return
    }

    await args.engine.tick(args.workerId, args.leaseMs)
  }

  const interval = setInterval(() => {
    void tick()
  }, args.pollIntervalMs)

  void tick()

  return () => {
    active = false
    clearInterval(interval)
  }
}
