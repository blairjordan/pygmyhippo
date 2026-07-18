import { defineWorkflow, endStep } from "pygmyhippo-sdk"
import { hermesTurn } from "pygmyhippo-hermes"

const runner = {
  url: process.env.HERMES_TURN_RUNNER_URL ?? "http://localhost:8765",
  token: process.env.HERMES_TURN_TOKEN ?? "replace-me",
}

/**
 * Mount or export this workflow module in a normal PygmyHippo application.
 * The runner is the only Hermes-specific service: it owns credentials and
 * posts a signed result to PygmyHippo's external-session resume endpoint.
 */
export const workflows = [
  defineWorkflow({
    name: "hermes-release-summary",
    version: 1,
    title: "Durable Hermes release summary",
    startAt: "summarise",
    steps: {
      summarise: hermesTurn({
        runner,
        step: "summarise",
        prompt: ({ input }) =>
          `Summarise this release note in three concise bullets: ${String(input.releaseNote ?? "")}`,
        completed: "done",
        failed: "turn-failed",
      }),
      "turn-failed": endStep({ label: "Hermes turn failed" }),
      done: endStep({ label: "Release summary complete" }),
    },
  }),
]
