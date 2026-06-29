# 🦛 Hippo

Postgres-native durable workflow engine built to orchestrate AI agent harnesses and long-running application workflows.

Hippo runs long-lived workflows with Postgres as the only durable state layer: leased workers, retries, waits, signals, schedules, child workflows, transactional step commits, and recovery after worker failure.

## Why Hippo

Hippo is built for teams that want durable workflow orchestration and state-machine execution without adding a separate control plane, managed cache, or complex cluster dependencies to their stack.

- **Postgres-native durability:** Workflow state, waits, retries, outbox records, operator history, and run-scoped KV store live in infrastructure most teams already run.
- **Same-transaction step commits:** Commit workflow progress and your application writes together, which is the practical moat for billing, fulfillment, and agent state tracking.
- **Local, staging, and prod parity:** Share one runtime shape and one environment model instead of requiring a separate operational platform.
- **Built-in dashboard & SSE event streams:** Visualise workflow state and stream execution steps live without standing up extra frontend services.
- **Operator rewind and fork:** Rewind terminal or in-flight runs to a prior step attempt from context snapshots, or fork into an alternate execution path.
- **TypeScript-first workflow definitions:** Keep business logic in ordinary code instead of pushing teams into a restricted workflow DSL.
- **Version-pinned execution:** Pinned in-flight runs execute on their starting definition version while new starts pick up the latest registered code version.

## Core Capabilities

Hippo provides the robust orchestrator layer you need underneath your agent harness or business workflows:

- **Durable Step Execution:** Each phase of execution is a step. Crashes resume at the last completed step instead of starting from scratch.
- **External Sessions:** Kick off long-running tasks outside the worker process (e.g. agent reasoning loops, browser automation, ML training) and attach to them with heartbeats, event streams, and cancellation hooks.
- **Human-in-the-Loop (Waits & Signals):** Pause execution for Slack approvals, human comments, or external callbacks. Blocks for hours or days without burning resources.
- **Budgeting & Cost Caps:** Sum cost and resource usage in real-time, enforcing run-level cost budgets with a dedicated `exhausted_budget` terminal state.
- **Run-Scoped Key-Value Store:** A run-scoped key-value scratchpad for steps to stash small bits of state across retries or phases.
- **Critic Loops & Retries:** Configure per-step retry policies with exponential backoff and jitter. Retries can be informed by previous attempts.
- **OTel Spans & Observability:** Native OpenTelemetry spans nested across HTTP boundaries, worker loops, and store transactions.

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>🐘 Postgres-Native Core</h3>
Workflow runs, step attempts, waits, signals, schedules, outbox records, and KV state live in Postgres. Workers stay stateless and recover from leases instead of carrying hidden local state.
</td>
<td align="center" width="33%">
<h3>⚡ Fast Wakeups</h3>
Workers poll safely, but `LISTEN/NOTIFY` wakes them early when new runs, resumed waits, signals, or recovered work become runnable.
</td>
<td align="center" width="33%">
<h3>🔁 Durable Retries</h3>
Task steps support per-step retry policy with capped exponential backoff, jitter, and non-retryable error tags.
</td>
</tr>
<tr>
<td align="center">
<h3>📨 Signals And Waits</h3>
Runs can block on external callbacks or named signals, resume exactly once, and fail cleanly on wait expiry instead of hanging forever.
</td>
<td align="center">
<h3>🧭 Child Workflows</h3>
A parent run can spawn a child workflow, wait durably for its terminal state, and resume with the child result once the child completes.
</td>
<td align="center">
<h3>🛑 Graceful Cancel & Hard Terminate</h3>
Graceful cancellation stops at step boundaries. Hard termination cuts the run over to `canceled` immediately, propagates down child runs, and runs compensation hooks.
</td>
</tr>
<tr>
<td align="center">
<h3>📚 Continue As New</h3>
Task steps can roll long-running work into a fresh run with a new payload while preserving an explicit chain link through `continued_from_run_id`.
</td>
<td align="center">
<h3>🧵 Queue Routing</h3>
Runs carry a task queue and priority so workers can specialize by workload instead of competing for one flat runnable set.
</td>
<td align="center">
<h3>🗓️ Cron Schedules</h3>
Server-side schedules create workflow runs from cron expressions without relying on an external trigger service.
</td>
</tr>
<tr>
<td align="center">
<h3>🧱 Same-Txn Step Commit</h3>
Transactional task steps can write application data and commit workflow progress in the same Postgres transaction.
</td>
<td align="center">
<h3>📦 Outbox Helper</h3>
Transactional steps can enqueue outbox records in the same transaction as step progress. A drain loop can deliver and mark them later.
</td>
<td align="center">
<h3>⏪ Rewind And Fork</h3>
Terminal runs can branch from a prior step attempt using the stored pre-step context snapshot, allowing operators to branch or replay without mutating workflow code.
</td>
</tr>
<tr>
<td align="center">
<h3>🛰️ OTel Tracing</h3>
HTTP requests, worker ticks, step execution, scheduler dispatch, recovery, outbox delivery, and store mutations emit nested OpenTelemetry-compatible spans.
</td>
<td align="center">
<h3>🗂️ Partitioned History</h3>
`workflow_step_attempts` and `workflow_events` are hash-partitioned by `run_id` to keep the hot history tables friendly to pruning.
</td>
<td align="center">
<h3>🌐 External Sessions</h3>
Attach to long-running tasks outside the worker (e.g. agent reasoning, ML training) with heartbeats, live event streams, and cancellation hooks.
</td>
</tr>
<tr>
<td align="center">
<h3>💸 Budgeting & Cost Caps</h3>
Track cost and resource usage in real-time, enforcing run-level resource or USD budgets with a dedicated `exhausted_budget` terminal state.
</td>
<td align="center">
<h3>🔑 Run-Scoped Key-Value Store</h3>
A run-scoped key-value scratchpad for steps to stash small bits of state across retries or phases without polluting payload schemas.
</td>
<td align="center">
<h3>📡 Live Event Streaming</h3>
Emit typed progress events or chunks directly from step execution to stream them live into monitoring UIs via SSE.
</td>
</tr>
</table>bles friendlier to pruning and long-lived fan-out.
</td>
</tr>
</table>

## Quickstart

From this repo today, scaffold a new Hippo app:

```bash
npm install
npm run hippo:init -- my-hippo-app
cd my-hippo-app
npm install
npm run hippo:dev
```

This creates a local app skeleton with Docker-backed Postgres, the built-in
dashboard, and an example workflow under `src/workflows/example.ts`.

Then open `http://127.0.0.1:3000/dashboard` and start an example run:

```bash
curl -X POST \
  -H "Authorization: Bearer demo-token" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/workflows/example-delivery/runs \
  -d '{"payload":{"email":"hello@example.com"}}'
```

The generated app includes:

- built-in dashboard with Mermaid workflow renders and SSE event tails
- clickable Mermaid step nodes on run detail pages for direct attempt inspection
- filtered operator run listing plus lineage inspection APIs
- durable retries with exponential backoff, jitter, and max delay cap
- graceful cancel, hard terminate, and compensation hooks
- public `hippo/sdk`, `hippo/core`, and `hippo/server` entrypoints for local package-style consumption
- workspace package previews under `packages/core`, `packages/sdk`, and `packages/server`
- local `docker compose` Postgres plus migrations and example workflow wiring

Required environment:

- `DATABASE_URL`

Optional environment:

- `HIPPO_ENV`
- `HIPPO_HOST`
- `HIPPO_PORT`
- `HIPPO_WORKER_ID`
- `HIPPO_TASK_QUEUES`
- `HIPPO_POLL_INTERVAL_MS`
- `HIPPO_LEASE_MS`
- `HIPPO_RECOVERY_INTERVAL_MS`
- `HIPPO_SCHEDULE_INTERVAL_MS`
- `HIPPO_OUTBOX_INTERVAL_MS`
- `HIPPO_NOTIFICATION_CHANNEL`
- `HIPPO_API_TOKEN`
- `HIPPO_CALLBACK_SECRET`
- `HIPPO_CALLBACK_TOLERANCE_SECONDS`

Environment-specific examples:

- `.env.example`
- `.env.staging.example`
- `.env.prod.example`

Development:

```bash
npm install
cp .env.example .env
npm run hippo:dev
```

This starts local Postgres via `docker compose`, waits for the database port,
runs migrations, then launches the API and worker.
In dev, changes under `src/workflows/*.ts` hot-reload registered definitions
without restarting the process. To change workflow behavior safely for new runs
while preserving pinned in-flight runs, bump the workflow `version`.

Environment modes:

- `HIPPO_ENV=dev` keeps local defaults permissive.
- `HIPPO_ENV=staging` and `HIPPO_ENV=prod` require both `HIPPO_API_TOKEN`
  and `HIPPO_CALLBACK_SECRET`.

Deployment recipes:

- [docs/deploy.md](docs/deploy.md)
- `Dockerfile`
- `fly.toml`
- `railway.json`
- `render.yaml`

If you prefer the steps manually:

```bash
docker compose up -d postgres
npm run db:migrate
npm run typecheck
npm run test
npm run lint
npm run dev
```

## Usage

Local public package entrypoints:

```ts
import { defineWorkflow, taskStep, endStep } from "hippo/sdk"
import { createHippoTracer, createWorkflowEngine, createWorkflowStore } from "hippo/core"
import { createApp, startWorkerLoop } from "hippo/server"
```

These entrypoints are verified locally through the package `exports` map today. The package is not published yet, so the source-repo workflow remains the supported install path.

Workspace package previews:

- `packages/core`
- `packages/sdk`
- `packages/server`

Running `npm run build` copies the compiled package-specific entrypoint artifacts
into those package directories so their exported entrypoints, manifests, and
README surfaces can be smoke-tested locally.

Tracing:

- Hippo exposes `createHippoTracer()` and emits nested spans through the runtime.
- To export traces, register your own OpenTelemetry SDK/provider in the host process before booting Hippo.

Start a run:

```bash
curl -X POST \
  -H "Authorization: Bearer $HIPPO_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/workflows/demo-delivery/runs \
  -d '{"payload":{},"taskQueue":"default","priority":0}'
```

Send a signal:

```bash
curl -X POST \
  -H "Authorization: Bearer $HIPPO_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/runs/<run-id>/signals/approved \
  -d '{"payload":{"approved":true}}'
```

Create a cron schedule:

```bash
curl -X POST \
  -H "Authorization: Bearer $HIPPO_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/operators/schedules \
  -d '{"workflowName":"demo","cronExpression":"*/5 * * * *","payload":{},"taskQueue":"default","priority":0}'
```

Cancel or terminate a run:

```bash
curl -X POST \
  -H "Authorization: Bearer $HIPPO_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/operators/runs/<run-id>/cancel \
  -d '{"mode":"graceful","reason":"operator request"}'

curl -X POST \
  -H "Authorization: Bearer $HIPPO_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/operators/runs/<run-id>/terminate \
  -d '{"reason":"operator request"}'
```

Rewind or fork a terminal run from a prior attempt:

```bash
curl -X POST \
  -H "Authorization: Bearer $HIPPO_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/operators/runs/<run-id>/rewind \
  -d '{"toAttemptId":"<attempt-id>"}'

curl -X POST \
  -H "Authorization: Bearer $HIPPO_API_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/operators/runs/<run-id>/fork \
  -d '{"fromAttemptId":"<attempt-id>"}'
```

Filter operator runs or inspect lineage:

```bash
curl -H "Authorization: Bearer $HIPPO_API_TOKEN" \
  "http://127.0.0.1:3000/v1/operators/runs?workflowName=demo-delivery&status=waiting&search=delivery&limit=25"

curl -H "Authorization: Bearer $HIPPO_API_TOKEN" \
  "http://127.0.0.1:3000/v1/operators/runs/<run-id>/lineage"
```

Render a workflow as Mermaid:

```bash
npm run render:demo
```

## Testing

Default checks:

```bash
npm run typecheck
npm run test
npm run lint
```

Postgres-backed integration tests:

```bash
HIPPO_PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  npm run test:pg
```
