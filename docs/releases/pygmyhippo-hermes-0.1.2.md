# pygmyhippo-hermes 0.1.2

## Runner release artifact

- Publishes `ghcr.io/blairjordan/pygmyhippo-hermes-runner:v0.1.2` from the
  `examples/hermes-runner` Dockerfile on a GitHub Release.
- Keeps the environment contract application-owned: `HIPPO_URL`,
  `HIPPO_CALLBACK_SECRET`, and `HERMES_TURN_TOKEN` are required; Hermes
  credentials/config are mounted or supplied by the embedding application.
- Emits OTel spans linked to the incoming PygmyHippo trace and carries W3C
  trace context onto signed callbacks.

## Safety and verification

- Runner tests prove SIGTERM reaches a live subprocess, callbacks are HMAC
  verifiable, failed Hermes processes fail their workflow, and trace IDs carry
  through into the runner span.
- Release CI builds the runner, runs registry-install and runner tests, then
  publishes npm and GHCR artifacts only after the checks succeed.
