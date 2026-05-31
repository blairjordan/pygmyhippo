# General Rules

Read this file on every task.

## Core Defaults

- Succinctness is valued.
- Never leave behind residual comments in code after refactoring, for example:

```typescript
// ❌ Bad: residual comment left behind
function connectToDatabase(uri: string) {
  // Removed retry logic - handled by connection pool now
  return new DbClient(uri)
}
```

- Do not assume any requirement to remain compatible with legacy code when asked to develop a feature. If you are unsure whether old data structures, APIs, or migrations must remain supported, ask first.

## Response Conventions

- For general code responses, explicitly state:
  `🐒 Abiding by coding laws`
- After each code change, include a Conventional Commit message summarising the change.
- Use `feat:`, `fix:`, `refactor:`, or `chore:`
- Keep the subject at 72 characters or fewer.
- Use imperative, present tense wording.
- Include scope when useful, for example: `refactor(ingestor): simplify pdf field persistence`
