"""Live progress events: the bus, the SSE stream and the endpoint.

`/investigate` only answers when the whole cycle is done, so before this a
client saw snapshots. These tests prove that progress is visible *during* the
cycle, in order, without duplicates, and that nothing secret is streamed.
"""

import asyncio
import json
import threading

import httpx
import pytest
from starlette.testclient import TestClient

from flow_helpers import corrupt_storage, new_session, submit
from operon_backend.events import END, EventBus, bus, emit_stage, format_sse, sse_stream
from operon_backend.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _no_retrieval(monkeypatch):
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])


def run(coro):
    return asyncio.run(coro)


# ---- the bus ----------------------------------------------------------------------------------


def test_events_get_increasing_ids_per_session():
    b = EventBus()
    ids = [b.publish("s1", "stage", stage="x", status="started")["id"] for _ in range(3)]
    other = b.publish("s2", "stage", stage="x", status="started")["id"]
    assert ids == [1, 2, 3] and other == 1


def test_a_late_subscriber_gets_the_replay_then_live_events_without_duplicates():
    async def go():
        b = EventBus()
        b.publish("s", "stage", stage="a", status="started")
        b.publish("s", "stage", stage="b", status="started")
        seen = []

        async def consume():
            async for e in b.subscribe("s"):
                seen.append(e["stage"])
                if len(seen) == 4:
                    return

        task = asyncio.ensure_future(consume())
        await asyncio.sleep(0.05)
        b.publish("s", "stage", stage="c", status="started")
        b.publish("s", "stage", stage="d", status="started")
        await asyncio.wait_for(task, 2)
        return seen, b.subscriber_count("s")

    seen, subscribers = run(go())
    assert seen == ["a", "b", "c", "d"]
    assert subscribers == 0  # the subscription was cleaned up


def test_resuming_after_an_id_skips_what_was_already_seen():
    b = EventBus()
    for name in "abc":
        b.publish("s", "stage", stage=name, status="started")
    assert [e["stage"] for e in b.history("s", after=2)] == ["c"]


def test_publishing_from_another_thread_reaches_the_subscriber():
    async def go():
        b = EventBus()
        got = []

        async def consume():
            async for e in b.subscribe("s"):
                got.append(e["stage"])
                return

        task = asyncio.ensure_future(consume())
        await asyncio.sleep(0.05)
        threading.Thread(target=lambda: b.publish("s", "stage", stage="from-thread", status="started")).start()
        await asyncio.wait_for(task, 2)
        return got

    assert run(go()) == ["from-thread"]


def test_history_is_bounded():
    b = EventBus(replay=5, max_sessions=2)
    for i in range(20):
        b.publish("s1", "stage", stage=str(i), status="started")
    assert len(b.history("s1")) == 5
    b.publish("s2", "stage", stage="x", status="started")
    b.publish("s3", "stage", stage="x", status="started")  # evicts the least recently used session
    assert b.history("s1") == []


# ---- what gets published -----------------------------------------------------------------------


def test_activity_entries_are_published_scrubbed():
    token = "".join(["gh", "p_", "A1b2C3d4E5f6G7h8J9k0", "A1b2C3d4E5f6G7h8J9k0"])
    s = new_session(client, issue=f"it broke, token {token}")
    events = bus.history(s["session_id"])
    assert events and events[0]["type"] == "activity" and events[0]["entry"]["kind"] == "session_created"
    assert token[4:] not in json.dumps(events)
    assert [e["entry"]["kind"] for e in events if e["type"] == "activity"][:2] == ["session_created", "evidence_requested"]


def test_a_cycle_publishes_its_stages_in_order():
    s = new_session(client)
    submit(client, s, storage=[corrupt_storage()])
    stages = [(e["stage"], e["status"]) for e in bus.history(s["session_id"]) if e["type"] == "stage"]
    assert stages == [
        ("investigate", "started"),
        ("investigate", "finished"),
        ("classify", "started"),
        ("classify", "finished"),
        ("diagnose", "started"),
        ("diagnose", "finished"),
        ("plan", "started"),
        ("plan", "finished"),
    ]


def test_sse_framing():
    text = format_sse({"id": 7, "type": "stage", "stage": "investigate"})
    assert text.startswith("id: 7\nevent: stage\ndata: ") and text.endswith("\n\n")
    assert json.loads(text.split("data: ", 1)[1])["stage"] == "investigate"


# ---- the stream ---------------------------------------------------------------------------------


def test_stream_of_a_terminal_session_ends_with_an_end_event():
    s = new_session(client)
    body = submit(client, s, storage=[corrupt_storage()]).json()["session"]
    client.post(f"/api/sessions/{s['session_id']}/policy", json={})
    client.post(f"/api/sessions/{s['session_id']}/approve", json={"approved": False})  # declined -> RESOLVED
    assert client.get(f"/api/sessions/{s['session_id']}").json()["phase"] == "RESOLVED"
    text = client.get(f"/api/sessions/{s['session_id']}/events").text
    events = [json.loads(chunk.split("data: ", 1)[1]) for chunk in text.strip().split("\n\n") if "data: " in chunk]
    assert events[-1]["type"] == END
    assert [e["entry"]["kind"] for e in events if e["type"] == "activity"][-1] == "approval"
    assert body["phase"] == "ACTION_PROPOSED"


def test_stream_resumes_after_an_id_on_a_finished_session():
    s = new_session(client)
    sid = s["session_id"]
    submit(client, s, storage=[corrupt_storage()])
    client.post(f"/api/sessions/{sid}/policy", json={})
    client.post(f"/api/sessions/{sid}/approve", json={"approved": False})  # RESOLVED: the stream replays and closes
    everything = bus.history(sid)
    cut = everything[len(everything) // 2]["id"]
    for header, query in (({"Last-Event-ID": str(cut)}, ""), ({}, f"?after={cut}")):
        text = client.get(f"/api/sessions/{sid}/events{query}", headers=header).text
        ids = [json.loads(c.split("data: ", 1)[1])["id"] for c in text.strip().split("\n\n") if "data: " in c]
        assert ids[0] == cut + 1 and ids[-1] > everything[-1]["id"]  # resumed after `cut`, ends with the END event


def test_unknown_session_stream_is_404():
    assert client.get("/api/sessions/does-not-exist/events").status_code == 404


@pytest.fixture
def live_server():
    """The real app on a real socket. TestClient and ASGITransport both buffer a
    whole response, so they cannot observe an open stream."""
    import socket

    import uvicorn

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        threading.Event().wait(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(5)


def test_progress_is_streamed_while_the_cycle_is_still_running(live_server, monkeypatch):
    """The point of the feature: events arrive *before* /investigate returns."""
    import time

    from operon_backend import investigation

    original = investigation.run_diagnosis

    async def slow_diagnosis(*args, **kwargs):  # stands in for the LLM round trip
        await asyncio.sleep(1.0)
        return await original(*args, **kwargs)

    monkeypatch.setattr(investigation, "run_diagnosis", slow_diagnosis)
    caps = ["inspect_page", "clear_storage_key", "reload", "unregister_service_worker", "console_errors", "network_requests"]
    created = httpx.post(f"{live_server}/api/sessions", json={"user_issue": "dashboard broken", "provider_capabilities": caps}).json()
    sid, request_id = created["session_id"], created["evidence_request"]["request_id"]

    arrivals: list[tuple[str, float]] = []

    def watch():
        with httpx.stream("GET", f"{live_server}/api/sessions/{sid}/events", timeout=30) as res:
            for line in res.iter_lines():
                if line.startswith("data: "):
                    event = json.loads(line[6:])
                    if event["type"] == "stage":
                        arrivals.append((f"{event['stage']}:{event['status']}", time.monotonic()))
                        if event["stage"] == "plan" and event["status"] == "finished":
                            return

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    time.sleep(0.3)
    bundle = {"url": "https://github.com/o/r", "timestamp": 1, "request_id": request_id, "storage": [corrupt_storage()]}
    res = httpx.post(f"{live_server}/api/sessions/{sid}/investigate", json={"bundle": bundle}, timeout=30)
    returned = time.monotonic()
    watcher.join(10)

    assert res.status_code == 200 and res.json()["session"]["phase"] == "ACTION_PROPOSED"
    names = [n for n, _ in arrivals]
    assert names[0] == "investigate:started" and names[-1] == "plan:finished"
    assert "diagnose:started" in names
    started = next(t for n, t in arrivals if n == "diagnose:started")
    assert returned - started > 0.8  # "diagnosis started" reached the client while the (slow) LLM call was still running


def test_stream_stops_when_the_client_disconnects_and_when_the_deadline_passes():
    async def go():
        b = EventBus()
        gone = {"v": False}

        async def consume():
            out = []
            async for chunk in sse_stream("s", 0, is_terminal=lambda: False, is_disconnected=lambda: gone["v"], heartbeat=0.05, event_bus=b):
                out.append(chunk)
                gone["v"] = True  # hang up after the first chunk
            return out

        out = await asyncio.wait_for(consume(), 2)
        timed = []
        async for chunk in sse_stream("t", 0, is_terminal=lambda: False, is_disconnected=lambda: False, max_seconds=0.2, heartbeat=0.05, event_bus=b):
            timed.append(chunk)
        return out, timed

    out, timed = run(go())
    assert out and out[0].startswith(": heartbeat")
    assert timed and all(c.startswith(": heartbeat") for c in timed)  # ended on its own at the cap


def test_emit_stage_helper():
    emit_stage("helper-session", "plan", "started", note="x")
    [event] = bus.history("helper-session")
    assert (event["type"], event["stage"], event["status"], event["note"]) == ("stage", "plan", "started", "x")
