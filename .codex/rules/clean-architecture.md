# Clean Architecture & Code Size Rules

Use this file to enforce architectural boundaries and keep codebase file sizes manageable.

## File Size Boundaries

- **Max Line Limit**: Handwritten TypeScript (`.ts`) source files must not exceed **500 lines**.
  - *Exceptions*: 
    - Auto-generated query files (e.g., `*.queries.ts`).
    - Database migrations and query files (e.g., `src/queries/*`).
    - Large integration test suites (e.g., `*.test.ts`) where grouping test cases is beneficial for readability. However, keep these under **1,000 lines** when possible.

## Separation of Concerns

### 1. Route Registries vs View Templates
- Fastify route registration files (e.g., in `src/routes/`) should serve purely as endpoints and middleware configuration.
- Do not define large HTML template strings, CSS styles, or page-layout helpers inline inside route handlers.
- Extract all page/view template logic into dedicated component views (e.g., in `src/views/`) and import them.

### 2. Workflow Engine vs Execution Steps
- The core workflow engine class/factory (`workflow-engine.ts`) should remain a high-level orchestrator and entry point for ticking, starting runs, and managing registries.
- Detailed step-by-step transition logic (the state machine execution, sleep/wait handlers) and specialized retry calculations should live in separate helper files (e.g., in `src/lib/engine/`).
