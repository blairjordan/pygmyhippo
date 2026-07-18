import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const hermesManifest = JSON.parse(await readFile(path.join(repoRoot, "packages/hermes/package.json"), "utf8"))
// A release must verify before it publishes its new npm version. Default to the
// known public package; callers can pin a newly published version afterwards.
const registryVersion = process.env.HERMES_REGISTRY_VERSION || "0.1.1"
const tempDir = await mkdtemp(path.join(os.tmpdir(), "pygmyhippo-hermes-registry-"))
const npm = process.platform === "win32" ? "npm.cmd" : "npm"

const run = (command, args) => execFileSync(command, args, {
  cwd: tempDir,
  stdio: "inherit",
})

try {
  await writeFile(path.join(tempDir, "package.json"), JSON.stringify({
    name: "pygmyhippo-hermes-registry-acceptance",
    private: true,
    type: "module",
  }, null, 2))
  await writeFile(path.join(tempDir, "workflow.ts"), `
import { defineWorkflow, endStep } from "pygmyhippo-sdk"
import { hermesTurn } from "pygmyhippo-hermes"

export const workflow = defineWorkflow({
  name: "registry-hermes-proof",
  version: 1,
  startAt: "agent",
  steps: {
    agent: hermesTurn({
      runner: { url: "http://runner.test", token: "test-token" },
      prompt: "reply with ACK",
    }),
    done: endStep(),
    "turn-failed": endStep(),
  },
})
`)
  await writeFile(path.join(tempDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["workflow.ts"],
  }, null, 2))
  await writeFile(path.join(tempDir, "lifecycle.mjs"), `
import assert from "node:assert/strict"
import { hermesTurn } from "pygmyhippo-hermes"

const requests = []
const step = hermesTurn({
  runner: {
    url: "http://runner.test/",
    token: "test-token",
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response("{}", { status: 202 })
    },
  },
  prompt: "reply with ACK",
})
const context = { run: {
  id: "run-1",
  definitionName: "registry-hermes-proof",
  traceContext: "00-11111111111111111111111111111111-2222222222222222-01",
} }
const started = await step.start(context)
assert.equal(started.externalId, "hermes:run-1")
assert.equal(requests[0].body.traceparent, context.run.traceContext)
const resumed = await step.resume({}, started.externalId, { status: "completed", output: "ACK", usage: { total_tokens: 3 } })
assert.deepEqual(resumed.patch, { hermes_output: "ACK", hermes_status: "completed", hermes_usage: { total_tokens: 3 } })
await step.cancel({}, started.externalId)
assert.equal(requests[1].url, "http://runner.test/turns/hermes%3Arun-1/cancel")
`)

  run(npm, ["install", "--ignore-scripts", "--no-package-lock", "pygmyhippo-sdk", `pygmyhippo-hermes@${registryVersion}`, "typescript"])
  run(npm, ["exec", "tsc", "--", "--project", "tsconfig.json"])
  run(process.execPath, ["lifecycle.mjs"])
  console.log(`Verified registry install for pygmyhippo-hermes@${registryVersion} (local target: ${hermesManifest.version})`)
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
