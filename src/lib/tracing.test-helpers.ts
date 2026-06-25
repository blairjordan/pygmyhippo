import type { Attributes, Context, Span, SpanStatus, Tracer } from "@opentelemetry/api"
import { trace } from "@opentelemetry/api"

export type RecordedSpan = {
  name: string
  parentName: string | null
  attributes: Record<string, unknown>
  events: string[]
  status: SpanStatus | null
  ended: boolean
}

class RecordingSpan implements Span {
  readonly record: RecordedSpan

  constructor(input: {
    name: string
    parentName: string | null
    attributes?: Attributes | undefined
  }) {
    this.record = {
      name: input.name,
      parentName: input.parentName,
      attributes: { ...(input.attributes ?? {}) },
      events: [],
      status: null,
      ended: false,
    }
  }

  spanContext() {
    return {
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      traceFlags: 1,
    }
  }

  setAttribute(key: string, value: unknown) {
    this.record.attributes[key] = value
    return this
  }

  setAttributes(attributes: Attributes) {
    Object.assign(this.record.attributes, attributes)
    return this
  }

  addEvent(name: string) {
    this.record.events.push(name)
    return this
  }

  setStatus(status: SpanStatus) {
    this.record.status = status
    return this
  }

  updateName(name: string) {
    this.record.name = name
    return this
  }

  end() {
    this.record.ended = true
  }

  isRecording() {
    return true
  }

  recordException() {}

  addLink() {
    return this
  }

  addLinks() {
    return this
  }
}

export const createRecordingTracer = () => {
  const spans: RecordedSpan[] = []
  const tracer = {
    startSpan(name: string, options?: { attributes?: Attributes }, parentContext?: Context) {
      const parentSpan = parentContext
        ? (trace.getSpan(parentContext) as RecordingSpan | undefined)
        : undefined
      const span = new RecordingSpan({
        name,
        parentName: parentSpan?.record.name ?? null,
        attributes: options?.attributes,
      })

      spans.push(span.record)
      return span
    },
  } as unknown as Tracer

  return {
    spans,
    tracer,
  }
}
