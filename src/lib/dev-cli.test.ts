import net from "node:net"

import { describe, expect, it } from "vitest"

import {
  createHippoDevPlan,
  getNpmCommand,
  parseEnvFileContent,
  resolveDatabaseAddress,
  waitForPort,
} from "./dev-cli.js"

describe("dev cli helpers", () => {
  it("builds the local dev command plan", () => {
    expect(createHippoDevPlan({ platform: "linux" })).toEqual([
      {
        kind: "setup",
        command: "docker",
        args: ["compose", "up", "-d", "postgres"],
      },
      {
        kind: "setup",
        command: "npm",
        args: ["run", "db:migrate"],
      },
      {
        kind: "serve",
        command: "npx",
        args: ["tsx", "watch", "src/index.ts"],
      },
    ])
  })

  it("parses dotenv-style file contents", () => {
    expect(
      parseEnvFileContent(`
        # comment
        DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/hippo
        HIPPO_PORT=3000
      `)
    ).toEqual({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:55432/hippo",
      HIPPO_PORT: "3000",
    })
  })

  it("resolves the database host and port from env", () => {
    expect(
      resolveDatabaseAddress({
        env: {
          DATABASE_URL:
            "postgres://postgres:postgres@db.internal:6543/hippo?sslmode=disable",
        },
      })
    ).toEqual({
      host: "db.internal",
      port: 6543,
    })
  })

  it("selects the platform-specific npm command", () => {
    expect(getNpmCommand("linux")).toBe("npm")
    expect(getNpmCommand("win32")).toBe("npm.cmd")
  })

  it("waits for a TCP port to become available", async () => {
    const server = net.createServer()

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })

    const address = server.address()

    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address")
    }

    await waitForPort({
      host: "127.0.0.1",
      port: address.port,
      timeoutMs: 200,
      retryDelayMs: 25,
    })

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  })
})
