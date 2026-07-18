"""Runner contract tests: process cancellation, signed callbacks, failures and traces."""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


RUNNER_PATH = Path(__file__).with_name("hermes_turn_runner.py")
SPEC = importlib.util.spec_from_file_location("hermes_turn_runner", RUNNER_PATH)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


class _Response:
    def __enter__(self): return self
    def __exit__(self, *_args): return False


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.config = runner.RunnerConfig("http://hippo.test", "callback-secret", "turn-token", (sys.executable,))
        runner.TURNS.clear()

    def _script(self, source: str) -> str:
        file = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False)
        file.write(source)
        file.close()
        self.addCleanup(lambda: Path(file.name).unlink(missing_ok=True))
        return file.name

    def _config_for(self, script: str):
        return runner.RunnerConfig(self.config.hippo_url, self.config.callback_secret, self.config.turn_token, (sys.executable, script))

    def test_hard_cancel_sends_sigterm_to_subprocess_group(self):
        marker = tempfile.NamedTemporaryFile(delete=False)
        marker.close()
        self.addCleanup(lambda: Path(marker.name).unlink(missing_ok=True))
        script = self._script("import signal,sys,time\npath=sys.argv[1]\ndef stop(*_): open(path,'w').write('SIGTERM'); raise SystemExit(0)\nsignal.signal(signal.SIGTERM, stop)\ntime.sleep(30)\n")
        config = runner.RunnerConfig(self.config.hippo_url, self.config.callback_secret, self.config.turn_token, (sys.executable, script, marker.name))
        callbacks = []
        worker = threading.Thread(target=runner.run_turn, args=(config, "hermes:cancel", "ignore", None, "test", "agent", None, lambda *_args: callbacks.append(_args[-1])))
        worker.start()
        deadline = time.time() + 5
        while "hermes:cancel" not in runner.TURNS and time.time() < deadline:
            time.sleep(0.02)
        self.assertTrue(runner.cancel_turn("hermes:cancel"))
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(Path(marker.name).read_text(), "SIGTERM")
        self.assertEqual(callbacks[0]["status"], "completed")

    def test_callback_signature_is_verifiable(self):
        sent = {}
        def urlopen(request, timeout):
            sent["request"], sent["timeout"] = request, timeout
            return _Response()
        with patch.object(runner.urllib.request, "urlopen", urlopen):
            runner.callback(self.config, "hermes:signature", {"status": "completed", "output": "ok"})
        request = sent["request"]
        body = request.data.decode()
        timestamp = request.headers["X-hippo-timestamp"]
        expected = hmac.new(self.config.callback_secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()
        self.assertEqual(request.headers["X-hippo-signature"], expected)
        self.assertEqual(json.loads(body)["payload"]["status"], "completed")

    def test_failed_hermes_process_fails_workflow(self):
        script = self._script("import sys\nprint('hermes failed', file=sys.stderr)\nsys.exit(7)\n")
        callbacks = []
        runner.run_turn(self._config_for(script), "hermes:failed", "ignore", None, "test", "agent", None, lambda *_args: callbacks.append(_args[-1]))
        self.assertEqual(callbacks, [{"status": "failed", "error": "hermes failed", "usage": {}}])

    def test_unstartable_hermes_process_fails_workflow(self):
        callbacks = []
        config = runner.RunnerConfig(self.config.hippo_url, self.config.callback_secret, self.config.turn_token, ("/does/not/exist/hermes",))
        runner.run_turn(config, "hermes:unstartable", "ignore", None, "test", "agent", None, lambda *_args: callbacks.append(_args[-1]))
        self.assertEqual(callbacks[0]["status"], "failed")
        self.assertIn("Unable to start Hermes", callbacks[0]["error"])

    @unittest.skipIf(runner.trace is None, "OpenTelemetry dependencies not installed")
    def test_otlp_span_uses_incoming_trace_id(self):
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        original = runner.TRACER
        runner.TRACER = provider.get_tracer("runner-test")
        try:
            script = self._script("print('ok')\n")
            traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
            runner.run_turn(self._config_for(script), "hermes:trace", "ignore", None, "test", "agent", traceparent, lambda *_args: None)
        finally:
            runner.TRACER = original
        spans = exporter.get_finished_spans()
        self.assertEqual(len(spans), 1)
        self.assertEqual(f"{spans[0].context.trace_id:032x}", "4bf92f3577b34da6a3ce929d0e0e4736")


if __name__ == "__main__":
    unittest.main()
