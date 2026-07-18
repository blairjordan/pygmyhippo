# PygmyHippo with Hermes

PygmyHippo remains a standalone, HTTP-first workflow engine. Hermes is an optional
consumer: it discovers PygmyHippo workflows through MCP and starts durable runs
through the native API.

## Standalone PygmyHippo

Run PygmyHippo with Postgres and define workflows in a JavaScript or TypeScript
module exporting `workflows`. Set `HIPPO_WORKFLOWS_PATH` to that module when the
definitions live outside the PygmyHippo package. PygmyHippo exposes:

- `GET /v1/workflows` for runtime workflow discovery;
- `POST /v1/workflows/:workflowName/runs` to start a run;
- `GET /v1/runs/:runId` for status, events, attempts, and result;
- operator cancellation, termination, signal, wait, schedule, and recovery APIs;
- `/metrics` for Prometheus and `/dashboard` for its operator UI.

Use a non-development `HIPPO_ENV` in containers. This disables source reloads
that need a writable application directory and requires an API token and
callback secret.

## Hermes package

Use [`pygmyhippo-hermes`](../packages/hermes/) when a workflow needs a durable
Hermes agent turn. The package provides `hermesTurn`, an external-session step
that starts a runner-owned turn, preserves `traceparent`, serialises output and
usage safely, handles duplicate callback delivery through PygmyHippo's native
idempotency, and asks the runner to stop on hard cancellation.

```ts
import { defineWorkflow, endStep } from "pygmyhippo-sdk"
import { hermesTurn } from "pygmyhippo-hermes"

export const workflows = [defineWorkflow({
  name: "release-summary",
  version: 1,
  startAt: "agent",
  steps: {
    agent: hermesTurn({
      runner: { url: process.env.HERMES_TURN_RUNNER_URL!, token: process.env.HERMES_TURN_TOKEN! },
      prompt: ({ input }) => `Summarise: ${String(input.text ?? "")}`,
    }),
    done: endStep(),
    "turn-failed": endStep(),
  },
})]
```

See the independent [Hermes example](../examples/hermes-integration/) for the
runner HTTP contract and deployment variables.

For a complete runner process that invokes the Hermes CLI, signs callbacks,
handles hard cancellation, and exports OTLP spans, start from
[the runner example](../examples/hermes-runner/).

## Hermes MCP adapter

The Hermes-specific layer is deliberately small:

1. Mount `hippo/mcp_server.py` and `hippo/flows.py` into Hermes.
2. Configure the MCP server with `PYGMYHIPPO_URL` and `HIPPO_API_TOKEN`.
3. Configure PygmyHippo with the same token and a mounted workflow module.
4. Let Hermes refresh tools normally; `mcp_server.py` calls `GET /v1/workflows`
   for every tool listing, so each registered workflow becomes an MCP tool.

This keeps PygmyHippo usable by any HTTP client and confines Hermes process,
credential, and prompt policy to the adapter repository.

## Runner boundary

The runner remains application-owned because it holds Hermes credentials and
chooses whether to invoke the Hermes CLI, gateway, or SDK. It must start turns,
accept cancellation, and sign callbacks. PygmyHippo owns durable workflow state
on both sides of that boundary; see the example for the precise contract.

## Observability

PygmyHippo exports run, failure, retry, step, duration, wait, and recovery
metrics. Scrape `/metrics` with a bearer token and add the Prometheus datasource
to Grafana. The Apollo integration provisions a PygmyHippo workflow dashboard.
