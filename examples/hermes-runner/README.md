# Hermes turn runner

This is a runnable, application-owned reference runner for
`pygmyhippo-hermes`. It invokes an installed Hermes CLI, handles process-group
cancellation, signs completion callbacks, and exports OpenTelemetry spans.

Install its optional telemetry dependencies alongside the Hermes CLI:

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
