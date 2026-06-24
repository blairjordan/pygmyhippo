import { describe, expect, it, vi } from "vitest"

import { drainOutbox } from "./outbox.js"
import type { WorkflowStore } from "./workflow-store.js"

describe("outbox", () => {
  it("delivers pending messages and marks them delivered", async () => {
    const handler = vi.fn(async () => undefined)
    const markOutboxDelivered = vi.fn(async () => true)
    const store = {
      async claimOutboxMessages() {
        return [
          {
            id: "outbox-1",
            runId: "run-1",
            topic: "email",
            payload: {
              id: "1",
            },
            availableAt: new Date(),
            deliveredAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]
      },
      markOutboxDelivered,
    } as Pick<WorkflowStore, "claimOutboxMessages" | "markOutboxDelivered">

    const delivered = await drainOutbox({
      handlers: {
        email: handler,
      },
      limit: 10,
      store: store as WorkflowStore,
    })

    expect(delivered).toBe(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(markOutboxDelivered).toHaveBeenCalledWith("outbox-1")
  })
})
