import { execFile } from "node:child_process"
import { mkdtemp, readFile, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

describe("hippo init cli", () => {
  it("scaffolds a runnable project skeleton", async () => {
    const sandboxDir = await mkdtemp(path.join(os.tmpdir(), "hippo-init-"))
    const projectDir = path.join(sandboxDir, "demo-app")
    const repoRoot = path.resolve(import.meta.dirname, "..", "..")

    await execFileAsync("npm", ["run", "hippo:init", "--", projectDir], {
      cwd: repoRoot,
    })

    const packageJson = JSON.parse(
      await readFile(path.join(projectDir, "package.json"), "utf8")
    ) as {
      name: string
      scripts: Record<string, string>
      dependencies: Record<string, string>
    }
    const workflowIndex = await readFile(
      path.join(projectDir, "src/workflows/index.ts"),
      "utf8"
    )
    const workflowFile = await readFile(
      path.join(projectDir, "src/workflows/example.ts"),
      "utf8"
    )
    const runtimeFile = await readFile(
      path.join(projectDir, "src/index.ts"),
      "utf8"
    )
    const readme = await readFile(path.join(projectDir, "README.md"), "utf8")

    const envFile = await readFile(path.join(projectDir, ".env"), "utf8")
    const envExampleFile = await readFile(path.join(projectDir, ".env.example"), "utf8")

    expect(packageJson.name).toBe("demo-app")
    expect(packageJson.scripts["hippo:dev"]).toBe("tsx src/index.ts")
    expect(packageJson.scripts["render:example"]).toBe(
      "tsx scripts/render-example.ts"
    )
    expect(packageJson.scripts["db:migrate"]).toBe("hippo migrate")
    expect(packageJson.scripts["start"]).toBeDefined()
    expect(packageJson.scripts["dev"]).toBeDefined()
    expect(packageJson.scripts["build"]).toBeDefined()
    expect(packageJson.dependencies).toMatchObject({
      "pygmyhippo-core": "0.1.0",
      "pygmyhippo-sdk": "0.1.0",
      "pygmyhippo-server": "0.1.0",
      "pygmyhippo-cli": "0.1.0",
    })

    expect(workflowIndex).toContain("exampleWorkflow")
    expect(workflowFile).toContain('name: "example-delivery"')
    expect(workflowFile).toContain('from "pygmyhippo-sdk"')
    expect(workflowFile).not.toContain("../lib/workflow-definition.js")
    expect(runtimeFile).toContain('from "pygmyhippo-server"')
    expect(runtimeFile).toContain("./src/workflows/index.ts")

    expect(readme).toContain("hippo init")
    expect(readme).toContain("npm install")
    expect(readme).toContain("npm run hippo:dev")
    expect(readme).toContain("npm run db:migrate")
    expect(readme).toContain("npm run render:example")
    expect(readme).toContain("curl -X POST")
    expect(readme).toContain('"payload":{"email":"hello@example.com"}')

    expect(envFile).toContain(
      "DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/hippo?sslmode=disable"
    )
    expect(envFile).toContain("HIPPO_API_TOKEN=demo-token")
    expect(envExampleFile).toContain(
      "DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/hippo?sslmode=disable"
    )

    await execFileAsync("npm", ["run", "build"], { cwd: repoRoot })

    await symlink(
      path.join(repoRoot, "node_modules"),
      path.join(projectDir, "node_modules"),
      "dir"
    )

    await execFileAsync("npm", ["run", "typecheck"], { cwd: projectDir })

    const { stdout: renderOutput } = await execFileAsync(
      "npm",
      ["run", "render:example"],
      { cwd: projectDir }
    )
    expect(renderOutput).toContain("flowchart TD")
    expect(renderOutput).toContain("classify_recipient")
  }, 30_000)
})
