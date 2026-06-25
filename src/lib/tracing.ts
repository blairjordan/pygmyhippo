import { AsyncLocalStorage } from "node:async_hooks"

import {
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Context,
  type Tracer,
} from "@opentelemetry/api"

type TraceAttributeValue = string | number | boolean | null | undefined

export type TraceAttributes = Record<string, TraceAttributeValue>

export type HippoSpan = {
  addEvent: (name: string, attributes?: TraceAttributes) => void
  setAttributes: (attributes: TraceAttributes) => void
}

export type HippoTracer = {
  withSpan: <T>(
    args: {
      name: string
      attributes?: TraceAttributes
    },
    run: (span: HippoSpan) => Promise<T> | T
  ) => Promise<T>
}

const createSpanOptions = (attributes?: TraceAttributes) => {
  const mappedAttributes = toAttributes(attributes)

  return mappedAttributes === undefined ? {} : { attributes: mappedAttributes }
}

const toAttributes = (attributes: TraceAttributes | undefined): Attributes | undefined => {
  if (!attributes) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) =>
      value === undefined || value === null ? [] : [[key, value]]
    )
  )
}

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown error"

export const createHippoTracer = (args?: {
  scopeName?: string
  tracer?: Tracer
}): HippoTracer => {
  const scopeName = args?.scopeName ?? "hippo"
  const otelTracer = args?.tracer ?? trace.getTracer(scopeName)
  const contextStorage = new AsyncLocalStorage<Context>()

  const withSpan: HippoTracer["withSpan"] = async (input, run) => {
    const parentContext = contextStorage.getStore() ?? context.active()
    const span = otelTracer.startSpan(
      input.name,
      createSpanOptions(input.attributes),
      parentContext
    )
    const spanContext = trace.setSpan(parentContext, span)
    const activeSpan: HippoSpan = {
      addEvent: (name, attributes) => {
        span.addEvent(name, toAttributes(attributes))
      },
      setAttributes: (attributes) => {
        span.setAttributes(toAttributes(attributes) ?? {})
      },
    }

    return contextStorage.run(spanContext, async () => {
      try {
        const result = await run(activeSpan)
        span.setStatus({ code: SpanStatusCode.OK })
        return result
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(getErrorMessage(error)))
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: getErrorMessage(error),
        })
        throw error
      } finally {
        span.end()
      }
    })
  }

  return {
    withSpan,
  }
}

export const createTraceAttributes = (args: {
  operation: string
  workflowName?: string
  workflowVersion?: number
  runId?: string
  stepKey?: string | null
  stepKind?: string
  taskQueue?: string
  workerId?: string
}) => ({
  "hippo.operation": args.operation,
  ...(args.workflowName === undefined ? {} : { "workflow.name": args.workflowName }),
  ...(args.workflowVersion === undefined
    ? {}
    : { "workflow.version": args.workflowVersion }),
  ...(args.runId === undefined ? {} : { "workflow.run.id": args.runId }),
  ...(args.stepKey === undefined || args.stepKey === null
    ? {}
    : { "workflow.step.key": args.stepKey }),
  ...(args.stepKind === undefined ? {} : { "workflow.step.kind": args.stepKind }),
  ...(args.taskQueue === undefined ? {} : { "workflow.task_queue": args.taskQueue }),
  ...(args.workerId === undefined ? {} : { "workflow.worker.id": args.workerId }),
})
