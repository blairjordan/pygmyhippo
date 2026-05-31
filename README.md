# 🦛 Hippo

Hippo is a database-native durable workflow engine.

It executes workflows with Postgres-backed state, leased workers, durable step attempts, resumable callback waits, and Mermaid-based workflow visualization.

## Current Shape

- TypeScript runtime with a functional core
- Postgres persistence
- Typed SQL query modules
- Fastify API surface
- Worker loop with durable run claims
- Mermaid workflow rendering
- Vitest coverage for workflow execution and rendering

## Development

```bash
npm install
npm run typecheck
npm run test
```

## Database

Set `DATABASE_URL` and run:

```bash
npm run db:migrate
```

## Workflow Rendering

Render the demo workflow as Mermaid:

```bash
npm run render:demo
```
