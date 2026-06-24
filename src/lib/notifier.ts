import { Client } from "pg"

import type { HippoConfig } from "./config.js"

export type WorkflowNotifier = {
  listen: (onNotification: () => void) => Promise<() => Promise<void>>
  notifyRunnable: () => Promise<void>
}

export const createWorkflowNotifier = (config: Pick<
  HippoConfig,
  "DATABASE_URL" | "HIPPO_NOTIFICATION_CHANNEL"
>): WorkflowNotifier => {
  const notifyRunnable = async () => {
    const client = new Client({
      connectionString: config.DATABASE_URL,
    })

    await client.connect()

    try {
      await client.query("SELECT pg_notify($1, $2)", [
        config.HIPPO_NOTIFICATION_CHANNEL,
        "runnable",
      ])
    } finally {
      await client.end()
    }
  }

  const listen = async (onNotification: () => void) => {
    const client = new Client({
      connectionString: config.DATABASE_URL,
    })

    await client.connect()
    client.on("notification", () => {
      onNotification()
    })
    await client.query(`LISTEN ${config.HIPPO_NOTIFICATION_CHANNEL}`)

    return async () => {
      client.removeAllListeners("notification")
      await client.end()
    }
  }

  return {
    listen,
    notifyRunnable,
  }
}
