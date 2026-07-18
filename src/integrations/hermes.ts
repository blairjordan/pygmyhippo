import { externalSession } from "../lib/workflow-definition.js"
import type {
  ExternalSessionStepDefinition,
  StepExecutionContext,
} from "../types/workflow.js"
import type { JsonObject, JsonValue } from "../types/json.js"

type HermesTurnResult = {
  status?: JsonValue
  output?: JsonValue
  error?: JsonValue
  usage?: JsonValue
}

export type HermesRunner = {
  /** Base URL of an application-owned Hermes runner service. */
  url: string
  /** Bearer credential accepted by the runner service. */
  token: string
  /** Injectable for tests or a non-standard HTTP runtime. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch
}

export type HermesTurnOptions = {
  runner: HermesRunner
  /** Prompt text, or a function that derives it from durable workflow state. */
  prompt: string | ((context: StepExecutionContext) => string)
  model?: string | ((context: StepExecutionContext) => string | undefined)
  step?: string
  label?: string
  timeoutMs?: number
  completed?: string
  failed?: string
}

const resolve = <T>(
  value: T | ((context: StepExecutionContext) => T),
  context: StepExecutionContext
) => typeof value === "function"
  ? (value as (input: StepExecutionContext) => T)(context)
  : value

const asObject = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {}

/**
 * Creates a durable external-session step for one Hermes agent turn.
 *
 * The runner is intentionally application-owned: it holds Hermes credentials,
 * starts the CLI/SDK process, and posts a signed completion callback back to
 * PygmyHippo. This package owns the portable workflow side of that contract:
 * start, resume, cancellation, JSON-safe result handling, and W3C trace handoff.
 */
export const hermesTurn = (options: HermesTurnOptions): ExternalSessionStepDefinition => {
  const completed = options.completed ?? "done"
  const failed = options.failed ?? "turn-failed"
  const step = options.step ?? "agent"
  const request = options.runner.fetch ?? globalThis.fetch

  if (!request) throw new Error("hermesTurn requires a fetch implementation")

  return externalSession({
    label: options.label ?? "Run Hermes turn",
    sessionKind: "hermes-turn",
    timeoutMs: options.timeoutMs ?? 900_000,
    transitions: { completed, failed },
    start: async (context) => {
      const prompt = resolve(options.prompt, context)
      if (!prompt.trim()) throw new Error("hermesTurn requires a non-empty prompt")
      const model = options.model === undefined ? undefined : resolve(options.model, context)
      const externalId = `hermes:${context.run.id}`
      const response = await request(`${options.runner.url.replace(/\/$/, "")}/turns`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.runner.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          external_id: externalId,
          prompt,
          ...(model === undefined ? {} : { model }),
          workflow: context.run.definitionName,
          step,
          ...(context.run.traceContext === undefined || context.run.traceContext === null
            ? {}
            : { traceparent: context.run.traceContext }),
        }),
      })
      if (!response.ok) throw new Error(`Hermes turn start failed: ${await response.text()}`)
      return { externalId }
    },
    resume: (_context, _externalId, payload) => {
      const result = asObject(payload) as HermesTurnResult
      const output = typeof result.output === "string" ? result.output : ""
      const succeeded = result.status === "completed" && typeof result.output === "string"
      const patch: JsonObject = {
        hermes_output: output,
        hermes_status: succeeded ? "completed" : "failed",
      }
      if (!succeeded) patch.hermes_error = typeof result.error === "string" ? result.error : "Hermes turn failed"
      if (result.usage !== undefined && result.usage !== null) patch.hermes_usage = result.usage
      return {
        patch,
        output: { response: output },
        transition: succeeded ? completed : failed,
      }
    },
    cancel: async (_context, externalId) => {
      const response = await request(
        `${options.runner.url.replace(/\/$/, "")}/turns/${encodeURIComponent(externalId)}/cancel`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.runner.token}`,
            "content-type": "application/json",
          },
          body: "{}",
        }
      )
      if (!response.ok && response.status !== 404) {
        throw new Error(`Hermes turn cancellation failed: ${await response.text()}`)
      }
    },
  })
}
