# Hermes turn runner

This is a runnable, application-owned reference runner for
`pygmyhippo-hermes`. It invokes an installed Hermes CLI, handles process-group
cancellation, signs completion callbacks, and exports OpenTelemetry spans.

It is also a versioned container artifact: GitHub Releases publish
`ghcr.io/blairjordan/pygmyhippo-hermes-runner:<release-tag>`. The image contains
the runner and its telemetry dependencies, but never credentials or config.

Run it with application-owned Hermes state/config mounted in:

```bash
docker run --rm -p 8765:8765 \
  -v "$PWD/hermes-state:/opt/data" \
  -e HIPPO_URL=http://host.docker.internal:3000 \
  -e HIPPO_CALLBACK_SECRET=replace-with-the-pygmyhippo-callback-secret \
  -e HERMES_TURN_TOKEN=replace-with-a-runner-bearer-token \
  ghcr.io/blairjordan/pygmyhippo-hermes-runner:v0.1.2
```

For a non-container deployment, install its optional telemetry dependencies
alongside the Hermes CLI:

```bash
python -m pip install -r requirements.txt
```

Required environment:

```bash
export HIPPO_URL=http://localhost:3000
export HIPPO_CALLBACK_SECRET=replace-with-the-pygmyhippo-callback-secret
export HERMES_TURN_TOKEN=replace-with-a-runner-bearer-token
```

Optional configuration:

```bash
export HERMES_COMMAND=hermes                  # or /path/to/hermes
export HERMES_WORKDIR=/srv/agent
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=my-hermes-runner
python hermes_turn_runner.py
```

`POST /turns` starts `hermes [-m model] -z prompt`; `POST
/turns/:externalId/cancel` sends `SIGTERM` to the process group; `GET /healthz`
is suitable for a container health check. The runner never receives PygmyHippo
database credentials or stores Hermes credentials itself—it uses the configured
Hermes CLI environment.

Run its contract tests after installing `requirements.txt`:

```bash
python -m unittest test_runner.py
```
