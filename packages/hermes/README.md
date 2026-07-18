# pygmyhippo-hermes

PygmyHippo external-session workflow steps for Hermes agent runners.

## Local Preview

```bash
npm install
npm run build
```

This workspace package builds its own distributable `dist` directory, matching
the artifact that is published to npm.

## Hermes turns

~~~ts
import { hermesTurn } from "pygmyhippo-hermes"

const agent = hermesTurn({
  runner: { url: process.env.HERMES_TURN_RUNNER_URL!, token: process.env.HERMES_TURN_TOKEN! },
  prompt: "Reply with a concise acknowledgement.",
})
~~~

The application-owned runner starts Hermes, accepts cancellation, and signs the
completion callback. This package owns the durable PygmyHippo external-session
step, W3C trace handoff, and JSON-safe output handling. See the repository's
examples/hermes-integration and docs/hermes-integration.md.
