export const defaultRetryBackoff = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  backoffMultiplier: 2,
  jitterMs: 250,
} as const

export const defaultCompensationRetryPolicy = {
  maxAttempts: 1,
  initialBackoffMs: 250,
  maxBackoffMs: 1_000,
  backoffMultiplier: 2,
  jitterMs: 50,
} as const

export const getRetryAvailableAt = (args: {
  attempt: number
  initialBackoffMs?: number
  maxBackoffMs?: number
  backoffMultiplier?: number
  jitterMs?: number
}) => {
  const initialBackoffMs =
    args.initialBackoffMs ?? defaultRetryBackoff.initialBackoffMs
  const maxBackoffMs = args.maxBackoffMs ?? defaultRetryBackoff.maxBackoffMs
  const backoffMultiplier =
    args.backoffMultiplier ?? defaultRetryBackoff.backoffMultiplier
  const jitterMs =
    args.jitterMs ??
    (initialBackoffMs === 0 ? 0 : defaultRetryBackoff.jitterMs)
  const exponentialDelay =
    initialBackoffMs * backoffMultiplier ** Math.max(0, args.attempt - 1)
  const cappedDelay = Math.min(exponentialDelay, maxBackoffMs)
  const jitterOffset =
    jitterMs <= 0 ? 0 : Math.round((Math.random() * 2 - 1) * jitterMs)
  const jitteredDelay = Math.min(
    maxBackoffMs,
    Math.max(0, cappedDelay + jitterOffset)
  )

  return new Date(Date.now() + jitteredDelay)
}

export const createRetryDelayInput = (retryPolicy: {
  initialBackoffMs?: number
  maxBackoffMs?: number
  backoffMultiplier?: number
  jitterMs?: number
}) => ({
  ...(retryPolicy.initialBackoffMs === undefined
    ? {}
    : { initialBackoffMs: retryPolicy.initialBackoffMs }),
  ...(retryPolicy.maxBackoffMs === undefined
    ? {}
    : { maxBackoffMs: retryPolicy.maxBackoffMs }),
  ...(retryPolicy.backoffMultiplier === undefined
    ? {}
    : { backoffMultiplier: retryPolicy.backoffMultiplier }),
  ...(retryPolicy.jitterMs === undefined
    ? {}
    : { jitterMs: retryPolicy.jitterMs }),
})

export const getErrorTag = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return null
  }

  const tagged = error as { tag?: unknown; code?: unknown; name?: unknown }

  if (typeof tagged.tag === "string") {
    return tagged.tag
  }

  if (typeof tagged.code === "string") {
    return tagged.code
  }

  if (typeof tagged.name === "string") {
    return tagged.name
  }

  return null
}
