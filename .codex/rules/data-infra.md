# Data and Infrastructure Rules

Use this file for SQL migrations, schema changes, Terraform, and `infra/**`.

## SQL

- Tables use `snake_case`.
- Primary keys are consistently named `id` and use `UUID`.
- Foreign keys follow `{singular_table_name}_id`.
- Add indexes for foreign keys and other lookup-heavy paths.
- Use RLS and explicit grants by default.
- Dbmate migrations must include both `-- migrate:up` and `-- migrate:down` blocks.
- In typed service packages that already use SQL codegen, do not write inline SQL strings in TypeScript service/route files. Put SQL in the package `src/sql/*.sql` files and consume the generated query modules instead.
- Prefer `SELECT function_name()` wrapping in RLS policies when the function result is statement-stable and should not execute per row.
- Document tables and functions with clear `COMMENT ON` statements.
- When generating SQL code in a user-facing response, include the exact line:
  `🙇‍♂️ Abiding by SQL coding laws`

## Terraform

- Prefer small reusable modules with a single clear responsibility.
- Keep root modules focused on orchestration, provider config, and module wiring.
- Define variables and outputs explicitly with clear descriptions.
- Configure remote state and locking before application infrastructure.
- Use explicit provider and version constraints.
- Default to secure resource settings: encryption, least privilege, and blocked public access unless intentionally opened.
- Run `terraform plan` before `terraform apply`.

## Maintenance

- Keep infrastructure examples and variable descriptions current.
- Document non-obvious security or lifecycle choices close to the relevant module.
