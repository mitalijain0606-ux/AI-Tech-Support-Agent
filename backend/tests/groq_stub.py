"""A local OpenAI-compatible HTTP server standing in for api.groq.com.

Unlike FakeGroq (flow_helpers.py), which replaces `llm._call_groq` wholesale,
this exercises the *real* client code — request construction, headers,
timeouts, status handling, response parsing — over a real socket. It is still
a stub of the remote service: it proves the client is correct against the
documented chat/completions contract, not that Groq's model behaves well.
That is what tests/live/test_live_groq.py is for.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

STUB_KEY = "test-key-for-local-stub-only"


def completion(content: Any) -> dict:
    """A chat.completion body whose message content is `content` (a string,
    or an object that is JSON-encoded)."""
    text = content if isinstance(content, str) else json.dumps(content)
    return {"id": "chatcmpl-stub", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": text}}]}


class Reply:
    def __init__(self, body: Any = None, *, status: int = 200, headers: dict | None = None, raw: str | None = None, delay: float = 0.0):
        self.body, self.status, self.headers, self.raw, self.delay = body, status, headers or {}, raw, delay


class StubGroqServer:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.script: list[Reply] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 — http.server API
                length = int(self.headers.get("content-length", 0))
                raw_body = self.rfile.read(length).decode()
                outer.requests.append(
                    {
                        "path": self.path,
                        "headers": {k.lower(): v for k, v in self.headers.items()},
                        "raw_body": raw_body,
                        "body": json.loads(raw_body) if raw_body else None,
                    }
                )
                reply = outer.script.pop(0) if outer.script else Reply({"error": {"message": "no scripted reply"}}, status=500)
                if reply.delay:
                    time.sleep(reply.delay)
                payload = reply.raw if reply.raw is not None else json.dumps(reply.body)
                try:
                    self.send_response(reply.status)
                    self.send_header("content-type", "application/json")
                    for k, v in reply.headers.items():
                        self.send_header(k, v)
                    self.send_header("content-length", str(len(payload.encode())))
                    self.end_headers()
                    self.wfile.write(payload.encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the client timed out and hung up

            def log_message(self, *args):
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}/openai/v1/chat/completions"

    def start(self) -> "StubGroqServer":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def reply(self, *replies: Reply | dict | str) -> None:
        for r in replies:
            self.script.append(r if isinstance(r, Reply) else Reply(completion(r)))
