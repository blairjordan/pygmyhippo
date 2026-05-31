import type { WorkflowEngine } from "./workflow-engine.js"

export const startWorkerLoop = (args: {
  engine: WorkflowEngine
  workerId: string
  pollIntervalMs: number
  leaseMs: number
  onError?: (error: unknown) => void
}) => {
  let active = true
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlightPromise: Promise<void> | null = null

  const schedule = () => {
    if (!active) {
      return
    }

    timer = setTimeout(() => {
      timer = null
      void tick()
    }, args.pollIntervalMs)
  }

  const tick = async () => {
    if (!active || inFlight) {
      schedule()
      return
    }

    inFlight = true
    inFlightPromise = (async () => {
      try {
        await args.engine.tick(args.workerId, args.leaseMs)
      } catch (error) {
        args.onError?.(error)
      } finally {
        inFlight = false
        inFlightPromise = null
        schedule()
      }
    })()

    await inFlightPromise
  }

  void tick()

  return async () => {
    active = false

    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    await inFlightPromise
  }
}
