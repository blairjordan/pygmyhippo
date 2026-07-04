import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

export type ScaffoldProjectArgs = {
  projectName: string
  targetDir: string
  repoRoot: string
}

const createExampleWorkflowSource = () => `import { createHash } from "node:crypto"

import {
  defineWorkflow,
  end,
  sleep,
  task,
  wait,
} from "pygmyhippo-sdk"

const createCorrelationKey = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24)

const asInputRecord = (input: unknown) =>
  input && typeof input === "object" ? (input as Record<string, unknown>) : {}

export const exampleWorkflow = defineWorkflow({
  name: "example-delivery",
  version: 1,
  title: "Example delivery workflow",
  startAt: "classify-recipient",
  steps: {
    "classify-recipient": task({
      label: "Classify recipient",
      transitions: {
        email: "send-email",
        sms: "send-sms",
        webhook: "send-webhook",
      },
      run: ({ input }) => {
        const payload = asInputRecord(input)
        const recipientType =
          typeof payload.email === "string"
            ? "email"
            : typeof payload.phoneNumber === "string"
              ? "sms"
              : "webhook"

        return {
          patch: { recipientType },
          transition:
            recipientType === "email"
              ? "send-email"
              : recipientType === "sms"
                ? "send-sms"
                : "send-webhook",
        }
      },
    }),
    "send-email": task({
      label: "Send email",
      next: "delivery-confirmation",
      retry: {
        maxAttempts: 3,
        initialBackoffMs: 1_000,
      },
      run: ({ idempotencyKey, input }) => ({
        patch: {
          provider: "email",
          outboundRequestId: createCorrelationKey(
            \`\${idempotencyKey}:email:\${String(asInputRecord(input).email)}\`
          ),
        },
        output: {
          accepted: true,
        },
      }),
    }),
    "send-sms": task({
      label: "Send SMS",
      next: "delivery-confirmation",
      retry: {
        maxAttempts: 3,
        initialBackoffMs: 1_000,
      },
      run: ({ idempotencyKey, input }) => ({
        patch: {
          provider: "sms",
          outboundRequestId: createCorrelationKey(
            \`\${idempotencyKey}:sms:\${String(asInputRecord(input).phoneNumber)}\`
          ),
        },
        output: {
          accepted: true,
        },
      }),
    }),
    "send-webhook": task({
      label: "Send webhook",
      next: "cooldown",
      retry: {
        maxAttempts: 3,
        initialBackoffMs: 1_000,
      },
      run: ({ idempotencyKey, input }) => ({
        patch: {
          provider: "webhook",
          outboundRequestId: createCorrelationKey(
            \`\${idempotencyKey}:webhook:\${String(asInputRecord(input).url)}\`
          ),
        },
        output: {
          accepted: true,
        },
      }),
    }),
    cooldown: sleep({
      label: "Cooldown",
      next: "delivery-confirmation",
      until: 5_000,
    }),
    "delivery-confirmation": wait({
      label: "Wait for provider callback",
      next: "done",
      timeoutMs: 86_400_000,
      open: ({ run, context }) => ({
        correlationKey: createCorrelationKey(
          \`\${run.id}:\${String(context.outboundRequestId ?? "missing")}\`
        ),
        payload: {
          outboundRequestId: context.outboundRequestId ?? null,
        },
      }),
      resume: (_context, payload) => ({
        patch: {
          providerResponse: payload ?? { status: "delivered" },
        },
      }),
    }),
    done: end({
      label: "Completed",
    }),
  },
})
`

const createWorkflowIndexSource = () => `import { exampleWorkflow } from "./example.js"

export const workflows = [exampleWorkflow]
`

const createRuntimeSource = () => `import { getConfig, runHippoProcessRole } from "pygmyhippo-server"

const main = async () => {
  const config = getConfig()
  await runHippoProcessRole({
    config,
    role: config.HIPPO_ROLE,
    workflowsPath: "./src/workflows/index.ts",
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`

const createRenderExampleSource = () => `import { renderWorkflowAsMermaid } from "pygmyhippo-sdk"

import { exampleWorkflow } from "../src/workflows/example.js"

console.log(renderWorkflowAsMermaid(exampleWorkflow))
`

const createPackageJson = (args: {
  projectName: string
  sourcePackage: {
    engines?: unknown
    version?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
}) => {
  const dependencies = args.sourcePackage.dependencies ?? {}
  const devDependencies = args.sourcePackage.devDependencies ?? {}
  const hippoVersion = args.sourcePackage.version ?? "0.1.0"

  return {
    name: sanitizePackageName(args.projectName),
    version: "0.1.0",
    private: true,
    type: "module",
    description: "Hippo workflow app scaffold",
    engines: args.sourcePackage.engines,
    scripts: {
      dev: "tsx src/index.ts",
      "hippo:dev": "tsx src/index.ts",
      start: "node dist/src/index.js",
      build: "tsc -p tsconfig.json",
      typecheck: "tsc --noEmit -p tsconfig.json",
      lint: "eslint .",
      "db:migrate": "hippo migrate",
      "render:example": "tsx scripts/render-example.ts",
    },
    dependencies: {
      pg: dependencies.pg,
      "pygmyhippo-core": hippoVersion,
      "pygmyhippo-sdk": hippoVersion,
      "pygmyhippo-server": hippoVersion,
      "pygmyhippo-cli": hippoVersion,
    },
    devDependencies: {
      "@eslint/js": devDependencies["@eslint/js"],
      "@types/node": devDependencies["@types/node"],
      "@typescript-eslint/eslint-plugin":
        devDependencies["@typescript-eslint/eslint-plugin"],
      "@typescript-eslint/parser": devDependencies["@typescript-eslint/parser"],
      eslint: devDependencies.eslint,
      tsx: devDependencies.tsx,
      typescript: devDependencies.typescript,
    },
  }
}

const createTsconfig = () => ({
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    outDir: "dist",
    rootDir: ".",
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    skipLibCheck: true,
    declaration: true,
    sourceMap: true,
    types: ["node"],
  },
  include: ["src/**/*.ts", "scripts/**/*.ts"],
})

const createEslintConfig = () => `import eslint from "@eslint/js"
import tsParser from "@typescript-eslint/parser"
import tsPlugin from "@typescript-eslint/eslint-plugin"

export default [
  eslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-undef": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**"],
  },
]
`

const createScaffoldReadme = (projectName: string) => `# ${projectName}

Bootstrapped by \`hippo init\`.

## Quickstart

\`\`\`bash
npm install
npm run hippo:dev
\`\`\`

Open \`http://127.0.0.1:3000/dashboard\` and start a run:

\`\`\`bash
curl -X POST \\
  -H "Authorization: Bearer demo-token" \\
  -H "Content-Type: application/json" \\
  http://127.0.0.1:3000/v1/workflows/example-delivery/runs \\
  -d '{"payload":{"email":"hello@example.com"}}'
\`\`\`

## Useful Commands

\`\`\`bash
npm run db:migrate
npm run render:example
npm run typecheck
\`\`\`
`

const createEnvExample = () => `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/hippo?sslmode=disable
HIPPO_ENV=dev
HIPPO_HOST=127.0.0.1
HIPPO_PORT=3000
HIPPO_WORKER_ID=hippo-local
HIPPO_TASK_QUEUES=default
HIPPO_POLL_INTERVAL_MS=1000
HIPPO_LEASE_MS=15000
HIPPO_API_TOKEN=demo-token
HIPPO_CALLBACK_SECRET=demo-secret
`

const createDockerCompose = () => `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: hippo
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "55432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d hippo"]
      interval: 2s
      timeout: 2s
      retries: 15
    volumes:
      - hippo-postgres-data:/var/lib/postgresql/data

volumes:
  hippo-postgres-data:
`

const sanitizePackageName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-_]+/g, "-")
    .replaceAll(/^-+|-+$/g, "") || "hippo-app"

const ensureTargetIsEmpty = async (targetDir: string) => {
  try {
    const entries = await readdir(targetDir)

    if (entries.length > 0) {
      throw new Error(`Target directory "${targetDir}" is not empty`)
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      await mkdir(targetDir, { recursive: true })
      return
    }

    throw error
  }
}

const writeJson = async (targetPath: string, value: unknown) => {
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

const parsePackageJson = async (repoRoot: string) =>
  JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    engines?: unknown
    version?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

export const scaffoldProject = async (args: ScaffoldProjectArgs) => {
  await ensureTargetIsEmpty(args.targetDir)

  await mkdir(path.join(args.targetDir, "src", "workflows"), { recursive: true })
  await mkdir(path.join(args.targetDir, "scripts"), { recursive: true })
  await writeJson(
    path.join(args.targetDir, "package.json"),
    createPackageJson({
      projectName: args.projectName,
      sourcePackage: await parsePackageJson(args.repoRoot),
    })
  )
  await writeJson(path.join(args.targetDir, "tsconfig.json"), createTsconfig())
  await writeFile(
    path.join(args.targetDir, ".env.example"),
    createEnvExample(),
    "utf8"
  )
  await writeFile(
    path.join(args.targetDir, "docker-compose.yml"),
    createDockerCompose(),
    "utf8"
  )
  await writeFile(
    path.join(args.targetDir, "eslint.config.js"),
    createEslintConfig(),
    "utf8"
  )
  await writeFile(
    path.join(args.targetDir, ".env"),
    createEnvExample(),
    "utf8"
  )
  await writeFile(
    path.join(args.targetDir, "README.md"),
    createScaffoldReadme(args.projectName),
    "utf8"
  )
  await writeFile(
    path.join(args.targetDir, "src", "index.ts"),
    createRuntimeSource(),
    "utf8"
  )
  await writeFile(
    path.join(args.targetDir, "src", "workflows", "example.ts"),
    createExampleWorkflowSource(),
    "utf8"
  )
  await writeFile(
    path.join(args.targetDir, "src", "workflows", "index.ts"),
    createWorkflowIndexSource(),
    "utf8"
  )
  await writeFile(
    path.join(args.targetDir, "scripts", "render-example.ts"),
    createRenderExampleSource(),
    "utf8"
  )

  return {
    packageName: sanitizePackageName(args.projectName),
    scaffoldId: createHash("sha256").update(args.targetDir).digest("hex").slice(0, 12),
  }
}
