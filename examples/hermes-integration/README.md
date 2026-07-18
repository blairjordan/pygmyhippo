# Hermes integration example

This is a portable PygmyHippo workflow module. It does not require Apollo.

Install the workflow SDK and Hermes integration package:

```bash
npm install pygmyhippo-sdk pygmyhippo-hermes
```

Set `HERMES_TURN_RUNNER_URL` and `HERMES_TURN_TOKEN`, then export `workflows`
from `workflow.ts` in the module configured by `HIPPO_WORKFLOWS_PATH`.

Validate the example from the repository root with:

```bash
npx tsc --noEmit -p examples/hermes-integration/tsconfig.json
```

The runner implements a deliberately small HTTP contract:

- `POST /turns` accepts `external_id`, `prompt`, optional `model`, `workflow`,
  `step`, and optional W3C `traceparent`; return `202` after starting Hermes.
- `POST /turns/:external_id/cancel` stops the underlying Hermes process and
  returns `202` or `200`.
- When the turn ends, the runner signs and posts `{payload: {status, output,
  usage}}` to PygmyHippo's `/v1/external-sessions/:externalId/resume` endpoint.

The callback endpoint is idempotent. A hard PygmyHippo cancellation invokes the
runner cancellation endpoint, allowing a runner to terminate the Hermes process
group rather than leave an agent turn running in the background.
