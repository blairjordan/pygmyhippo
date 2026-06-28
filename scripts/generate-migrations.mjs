import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const migrationsDir = path.join(repoRoot, "db", "migrations")
const outputFilePath = path.join(repoRoot, "src", "lib", "migrations.ts")

const main = async () => {
  const files = await readdir(migrationsDir)
  const sqlFiles = files.filter((file) => file.endsWith(".sql")).sort()

  const migrationEntries = []

  for (const filename of sqlFiles) {
    const fullPath = path.join(migrationsDir, filename)
    const sqlContent = await readFile(fullPath, "utf8")
    migrationEntries.push({
      name: filename,
      sql: sqlContent,
    })
  }

  const outputCode = `// Generated automatically by scripts/generate-migrations.mjs. Do not edit directly.

export const migrations = ${JSON.stringify(migrationEntries, null, 2)} as const satisfies readonly {
  readonly name: string
  readonly sql: string
}[]
`

  await writeFile(outputFilePath, outputCode, "utf8")
  console.log(`Generated migrations file at ${outputFilePath}`)
}

main().catch((error) => {
  console.error("Failed to generate migrations file:", error)
  process.exitCode = 1
})
