# TypeScript Development Rules

Use this file for TypeScript and JavaScript work across the repo.

## Overview & Philosophy

- Comments are allowed only to explain:
  - Domain intent or business invariants
  - Non-obvious constraints or regulatory rules
  - Performance tradeoffs or algorithmic guarantees
- Comments must explain `why`, never `what`.
- Only use comments for extremely obscure operations that cannot be clarified through naming.
- Prefer a functional programming approach with strong typing.
- Prefer literal-preserving inference and immutable-by-default APIs.
- Clean separation of concerns between modules.
- Favor functional composition over class inheritance.
- Prefer JavaScript-native constructs such as unions, plain objects, and `as const` over TypeScript-only runtime constructs unless interop requires otherwise.
- Structured error handling, clear propagation to boundaries, and comprehensive logging.

## Abstraction Principles

### Keep Generic Abstractions Behaviour-Agnostic

- Generic abstractions must not contain domain-specific branching or policy logic. Behaviour should be injected by consumers.

```typescript
// ✅ Good: factory remains generic, specifics handled by consumer
const factory = (args: Args, getMetadata: (args: Args) => Metadata) => ({
  metadata: getMetadata(args),
})

// ❌ Bad: factory knows about specific parameter handling
const factory = (args: { pluginId?: string }) => ({
  metadata: args.pluginId ? { pluginId: args.pluginId } : {},
})
```

### Additional Principles

- Single responsibility: each abstraction should serve one clear purpose.
- Dependency injection: dependencies are explicitly passed, never hardcoded.
- Interface segregation: prefer minimal, focused interfaces.
- Open/closed principle: prefer extension through composition over modifying shared abstractions.
- Keep business logic separate from infrastructure boundaries.

### Named Format Payloads Over Ad Hoc Shared Object Literals

- When a runtime/export/editor payload has several fields that only make sense together for one format, give it a named type and a format-owned builder/helper.
- Do not assemble these payloads ad hoc inside shared orchestration code.
- If an object literal contains three or more closely related format-specific fields, treat that as a likely missing abstraction.

```typescript
type FormRuntimeMetadata = {
  renderedBodyHtml: string
  renderedDocumentHtml: string
  renderedStyles: string
}

const buildFormRuntimeMetadata = (args: Args): FormRuntimeMetadata => ({ ... })
```

## Structure & Organization

### Service Package Layout

- In service-style packages, keep responsibilities aligned with the existing structure:
  - `src/service/` for service-specific implementations
  - `src/lib/` for shared utilities and core functionality
  - `src/types/` for package-local type definitions when the package uses that split
- Files should handle a single responsibility or domain concern.

### Service Import Patterns

- Use barrel files when they reduce import churn.
- Barrel files must contain only re-exports, never implementation.
- Use `import type` and `export type` for symbols used only in type positions.
- Keep runtime imports explicit so module side effects and emitted JavaScript stay obvious.
- This matters more in packages using `verbatimModuleSyntax`, `bundler`, or `NodeNext` semantics.

```typescript
// ✅ Good
import { createServiceA, createServiceB } from "./service"

// ❌ Bad
import { createServiceA } from "./service/service-a"
import { createServiceB } from "./service/service-b"
```

```typescript
// ✅ Good: barrel file contains only re-exports
export { createServiceA } from "./service-a.js"
export { createServiceB } from "./service-b.js"
```

```typescript
import { createClient } from "./client.js"
import type { ClientConfig, SessionPayload } from "./types.js"
```

### Global Service Philosophy

- Keep globally available services limited to core infrastructure.
- Prefer service initialization via consistent factory patterns.
- Pass dependencies explicitly into services and handlers instead of importing them directly.

## Naming Conventions

- Use descriptive, self-explanatory names.
- Use named parameters when a function takes multiple inputs.

```typescript
// ✅ Good
new SQSClient({ region: env.AWS_REGION })
createService({ pool, s3Client, bucketName })

// ❌ Bad
new SQSClient(env.AWS_REGION)
createService(pool, s3Client, bucketName)
```

- Prefer arrow functions over the traditional `function` keyword unless hoisting or framework APIs make `function` clearer.
- Keep interfaces and types focused and explicit.

## Core Patterns & Best Practices

### Code Style Fundamentals

- Use strong typing at boundaries.
- Prefer functions and plain objects over classes unless stateful lifecycle management clearly needs a class.
- Use type guards for runtime type narrowing.
- Prefer descriptive names instead of explanatory comments whenever possible.

### Async Operations

- Use `async`/`await` by default.
- Avoid `.then()`, `.catch()`, and `.finally()` unless required by an external API or a specific control-flow need.

### Control Flow Patterns

#### Prefer Discriminated Unions Over Boolean Modes

- Avoid boolean flags or multiple optional parameters that create implicit modes.
- Model modeful behaviour with discriminated unions so invalid combinations become unrepresentable.
- Prefer data-first variants that compose cleanly in pure functions.

```typescript
type OutputRequest =
  | { kind: "html"; source: string }
  | { kind: "pdf"; templateId: string }

const assertUnreachable = (value: never): never => {
  throw new Error(`Unhandled case: ${String(value)}`)
}

const runOutputRequest = (request: OutputRequest): Promise<string> => {
  switch (request.kind) {
    case "html":
      return renderHtml(request.source)
    case "pdf":
      return renderPdf(request.templateId)
    default:
      return assertUnreachable(request)
  }
}
```

#### Dispatch Maps for Dynamic Runtime Keys

- Use `Map` or object dispatch tables when dealing with dynamic keys or handler lookup.
- Prefer typed registries built with `as const satisfies` over loosely typed objects, repeated string comparisons, or parallel arrays.
- Derive key unions from the registry when the registry is the source of truth.
- Keep runtime lookup tables and type-level unions aligned from one definition.

```typescript
type WritebackStatus = "pending" | "writing" | "failed" | "complete"

const writebackStatusLabels = {
  pending: "Pending",
  writing: "Writing back",
  failed: "Failed",
  complete: "Complete",
} as const satisfies Record<WritebackStatus, string>

const getWritebackStatusLabel = (status: WritebackStatus) =>
  writebackStatusLabels[status]
```

#### Switch for Closed Mode-Driven Branching

- Use `switch` when branching over a closed set of known modes or discriminants.
- Closed unions and mode switches must be exhaustive.
- Use a `never` check or `assertUnreachable()` in the default path when a switch is expected to cover all cases.
- Do not silently return `undefined` from a closed union branch just to satisfy control flow.

```typescript
const assertUnreachable = (value: never): never => {
  throw new Error(`Unhandled case: ${String(value)}`)
}

const getStatusTone = (status: WritebackStatus) => {
  switch (status) {
    case "pending":
      return "muted"
    case "writing":
      return "info"
    case "failed":
      return "danger"
    case "complete":
      return "success"
    default:
      return assertUnreachable(status)
  }
}
```

#### Runtime Dispatch

- Prefer declarative dispatch maps over nested `if` chains when behaviour is mode-driven.

#### Avoid Re-encoding Typed Data In Control Flow

- If a boundary already accepts the needed type, pass the value directly.
- Do not introduce pass-through wrappers with no policy, invariant, validation, or boundary adaptation.
- Do not introduce helpers whose main purpose is branching on a discriminated union, optional field, or mode only to restate, forward, or lightly reshape data that is already represented by the input type.
- Branching is justified when it selects different behaviour, enforces an invariant, validates external input, or crosses a real boundary between modules/services.
- Branching is a smell when it only compensates for an API that is too vague, too generic, or missing a variant-owned contract.
- Avoid executable duplication of type structure. If the schema and TypeScript type already describe the shape, do not add code that manually re-encodes the same shape through `if`/`switch` orchestration.

Use this test before adding branching orchestration:

1. Is this branch selecting behaviour, or just reconstructing data?
2. Would a narrower interface or variant-owned helper make this branch unnecessary?
3. Is this logic enforcing a real boundary, or compensating for a weak one?

If the control flow mainly reconstructs already-typed data, redesign the interface instead.

```typescript
type Delivery =
  | { kind: "email"; to: string; subject: string; body: string }
  | { kind: "sms"; to: string; message: string }

// ✅ Good: direct data flow into a boundary that already accepts the type
deliveryQueue.enqueue(input.delivery)

// ❌ Bad: branch only to reconstruct the same union shape
const payload =
  input.delivery.kind === "email"
    ? {
        kind: "email",
        to: input.delivery.to,
        subject: input.delivery.subject,
        body: input.delivery.body,
      }
    : {
        kind: "sms",
        to: input.delivery.to,
        message: input.delivery.message,
      }

deliveryQueue.enqueue(payload)
```
