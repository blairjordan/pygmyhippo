"""Reference HTTP runner for ``pygmyhippo-hermes`` workflow steps.

The runner is deliberately application-owned: it invokes the locally installed
Hermes CLI using that application's credentials, then signs a callback to the
PygmyHippo external-session endpoint. PygmyHippo owns durable state; this
process owns the short-lived agent subprocess.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import shlex
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from opentelemetry import context, propagate, trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.trace import Status, StatusCode
except ImportError:  # Allows a no-telemetry local proof without optional deps.
    context = propagate = trace = None
    OTLPSpanExporter = Resource = TracerProvider = BatchSpanProcessor = None
    Status = StatusCode = None


HIPPO_URL = os.environ["HIPPO_URL"].rstrip("/")
HIPPO_CALLBACK_SECRET = os.environ["HIPPO_CALLBACK_SECRET"]
TURN_TOKEN = os.environ["HERMES_TURN_TOKEN"]
HERMES_COMMAND = shlex.split(os.environ.get("HERMES_COMMAND", "hermes"))
HERMES_WORKDIR = os.environ.get("HERMES_WORKDIR") or None
TURNS: dict[str, subprocess.Popen[str]] = {}
TURNS_LOCK = threading.Lock()


class _NullSpan:
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def set_attribute(self, *_args): pass
    def set_status(self, *_args): pass
    def record_exception(self, *_args): pass


class _NullTracer:
    def start_as_current_span(self, *_args): return _NullSpan()


def configure_tracing():
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if trace is None or not endpoint:
        return None
    provider = TracerProvider(resource=Resource.create({
        "service.name": os.environ.get("OTEL_SERVICE_NAME", "pygmyhippo-hermes-runner"),
        "service.namespace": os.environ.get("OTEL_SERVICE_NAMESPACE", "pygmyhippo"),
        "service.instance.id": socket.gethostname(),
    }))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    return provider


TRACER_PROVIDER = configure_tracing()
TRACER = trace.get_tracer("pygmyhippo.hermes-runner") if trace is not None else _NullTracer()


def canonical_json(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def callback(external_id: str, payload: dict) -> None:
    body = {"payload": payload}
    timestamp = str(int(time.time()))
    signature = hmac.new(
        HIPPO_CALLBACK_SECRET.encode(),
        f"{timestamp}.{canonical_json(body)}".encode(),
        hashlib.sha256,
    ).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "X-Hippo-Timestamp": timestamp,
        "X-Hippo-Signature": signature,
    }
    if propagate is not None:
        carrier: dict[str, str] = {}
        propagate.inject(carrier)
        if carrier.get("traceparent"):
            headers["traceparent"] = carrier["traceparent"]
    request = urllib.request.Request(
        f"{HIPPO_URL}/v1/external-sessions/{external_id}/resume",
        data=canonical_json(body).encode(), method="POST", headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=30):
            pass
    except urllib.error.HTTPError as exc:
        if exc.code != HTTPStatus.NOT_FOUND:
            raise


def run_turn(external_id: str, prompt: str, model: str | None, workflow: str, step: str, traceparent: str | None) -> None:
    command = [*HERMES_COMMAND]
    if model:
        command.extend(["-m", model])
    command.extend(["-z", prompt])
    token = None
    if traceparent and context is not None and propagate is not None:
        token = context.attach(propagate.extract({"traceparent": traceparent}))
    try:
        with TRACER.start_as_current_span("pygmyhippo.hermes.turn") as span:
            span.set_attribute("workflow.name", workflow)
            span.set_attribute("workflow.step.id", step)
            span.set_attribute("workflow.step.kind", "external_session")
            span.set_attribute("workflow.run.id", external_id.removeprefix("hermes:"))
            span.set_attribute("gen_ai.operation.name", "invoke_agent")
            if model: span.set_attribute("gen_ai.request.model", model)
            started = time.monotonic()
            process = subprocess.Popen(command, cwd=HERMES_WORKDIR, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
            with TURNS_LOCK: TURNS[external_id] = process
            stdout, stderr = process.communicate()
            with TURNS_LOCK: TURNS.pop(external_id, None)
            span.set_attribute("workflow.duration_ms", round((time.monotonic() - started) * 1000))
            if process.returncode == 0:
                span.set_attribute("workflow.outcome", "success")
                span.set_attribute("workflow.response.chars", len(stdout.strip()))
                if Status is not None: span.set_status(Status(StatusCode.OK))
                payload = {"status": "completed", "output": stdout.strip(), "usage": {}}
            else:
                error = stderr.strip()[-4_000:] or f"Hermes exited {process.returncode}"
                span.set_attribute("workflow.outcome", "failed")
                span.record_exception(RuntimeError(error))
                if Status is not None: span.set_status(Status(StatusCode.ERROR, error))
                payload = {"status": "failed", "error": error, "usage": {}}
            callback(external_id, payload)
        if TRACER_PROVIDER is not None:
            TRACER_PROVIDER.force_flush(timeout_millis=10_000)
    finally:
        if token is not None and context is not None:
            context.detach(token)


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        data = canonical_json(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self) -> bool:
        return hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TURN_TOKEN}")

    def do_GET(self) -> None:
        if self.path == "/healthz": self._json(HTTPStatus.OK, {"status": "pass"})
        else: self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._authorised():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"}); return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        except (ValueError, json.JSONDecodeError):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"}); return
        if self.path == "/turns":
            external_id, prompt = body.get("external_id"), body.get("prompt")
            if not isinstance(external_id, str) or not isinstance(prompt, str):
                self._json(HTTPStatus.BAD_REQUEST, {"error": "external_id and prompt are required strings"}); return
            model, workflow, step, traceparent = body.get("model"), body.get("workflow", "unknown"), body.get("step", "agent"), body.get("traceparent")
            if any(value is not None and not isinstance(value, str) for value in (model, traceparent)) or not isinstance(workflow, str) or not isinstance(step, str):
                self._json(HTTPStatus.BAD_REQUEST, {"error": "model, workflow, step, and traceparent must be strings"}); return
            threading.Thread(target=run_turn, args=(external_id, prompt, model, workflow, step, traceparent), daemon=True).start()
            self._json(HTTPStatus.ACCEPTED, {"external_id": external_id}); return
        if self.path.startswith("/turns/") and self.path.endswith("/cancel"):
            external_id = self.path.removeprefix("/turns/").removesuffix("/cancel")
            with TURNS_LOCK: process = TURNS.get(external_id)
            if process and process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                self._json(HTTPStatus.ACCEPTED, {"external_id": external_id, "status": "cancelling"})
            else:
                self._json(HTTPStatus.OK, {"external_id": external_id, "status": "not_running"})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def log_message(self, _format: str, *_args: object) -> None: return


ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("HERMES_TURN_RUNNER_PORT", "8765"))), Handler).serve_forever()
