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

## Hermes adapter

The Hermes-specific layer is deliberately small:

1. Mount `hippo/mcp_server.py` and `hippo/flows.py` into Hermes.
2. Configure the MCP server with `PYGMYHIPPO_URL` and `HIPPO_API_TOKEN`.
3. Configure PygmyHippo with the same token and a mounted workflow module.
4. Let Hermes refresh tools normally; `mcp_server.py` calls `GET /v1/workflows`
   for every tool listing, so each registered workflow becomes an MCP tool.

This keeps PygmyHippo usable by any HTTP client and confines Hermes process,
credential, and prompt policy to the adapter repository.

## Agent steps

PygmyHippo task definitions own execution. For a Hermes-backed task, put the
Hermes invocation behind an application-owned task helper and return only JSON
serialisable `patch`, `output`, and transition data. Keep cancellation
cooperative: check the run's cancellation signal at tool and turn boundaries,
and use PygmyHippo's hard terminate only when the underlying execution can be
stopped safely.

The included Apollo `ack-demo` is intentionally deterministic: it verifies
durable sequencing and MCP promotion without spending model tokens. Production
agent workflows should replace those task bodies with the application's Hermes
turn adapter and retain the same workflow-control surface.

## Observability

PygmyHippo exports run, failure, retry, step, duration, wait, and recovery
metrics. Scrape `/metrics` with a bearer token and add the Prometheus datasource
to Grafana. The Apollo integration provisions a PygmyHippo workflow dashboard.
