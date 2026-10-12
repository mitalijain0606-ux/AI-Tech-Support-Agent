"""Live progress events for a SupportSession.

`POST /investigate` answers once, when the whole cycle is finished — which
includes waiting on the LLM. Nothing in that response tells the user what is
happening in the meantime, so clients only ever saw snapshots. This module is
the missing piece: every activity entry and every pipeline stage boundary is
published here as it happens, and `GET /api/sessions/{id}/events` streams them
(Server-Sent Events) to whoever is watching.

Design notes
- Events are *progress*, not truth. The session row (committed at the end of a
  cycle) stays authoritative: a cycle that fails and rolls back may already
  have streamed events for work whose result was discarded. Clients treat the
  stream as a live view and re-read the session when the cycle ends.
- Events carry the same secret-free summaries the activity log stores
  (activity._scrub), never raw evidence or page content.
- In-process and bounded: a per-session replay buffer (so a subscriber that
  connects slightly late, or reconnects with Last-Event-ID, misses nothing)
  and a cap on how many sessions are remembered. A multi-instance deployment
  needs a shared bus (Redis pub/sub); `EventBus` is the seam for that.
"""

import asyncio
import logging
import threading
from collections import OrderedDict, deque
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

REPLAY_PER_SESSION = 200
MAX_SESSIONS_REMEMBERED = 500
MAX_STREAM_SECONDS = 300
HEARTBEAT_SECONDS = 15.0

# Event types
ACTIVITY = "activity"  # one durable activity-log entry
STAGE = "stage"  # a pipeline stage started / finished
END = "end"  # the session reached a terminal phase


class EventBus:
    def __init__(self, replay: int = REPLAY_PER_SESSION, max_sessions: int = MAX_SESSIONS_REMEMBERED) -> None:
        self._replay = replay
        self._max_sessions = max_sessions
        self._lock = threading.Lock()
        self._history: OrderedDict[str, deque[dict[str, Any]]] = OrderedDict()
        self._counters: dict[str, int] = {}
        self._subscribers: dict[str, list[tuple[asyncio.AbstractEventLoop, asyncio.Queue[dict[str, Any]]]]] = {}

    def publish(self, session_id: str, event_type: str, **data: Any) -> dict[str, Any]:
        """Records an event and hands it to live subscribers. Safe to call from
        any thread (the investigation runs partly in a threadpool)."""
        with self._lock:
            number = self._counters.get(session_id, 0) + 1
            self._counters[session_id] = number
            event = {"id": number, "type": event_type, "at": datetime.now(UTC).isoformat(), **data}
            history = self._history.setdefault(session_id, deque(maxlen=self._replay))
            history.append(event)
            self._history.move_to_end(session_id)
            while len(self._history) > self._max_sessions:
                evicted, _ = self._history.popitem(last=False)
                self._counters.pop(evicted, None)
            targets = list(self._subscribers.get(session_id, ()))
        for loop, queue in targets:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, event)
            except RuntimeError:  # the subscriber's loop is already closed
                pass
        return event

    def history(self, session_id: str, after: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            return [e for e in self._history.get(session_id, ()) if e["id"] > after]

    async def subscribe(self, session_id: str, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        """Yields the buffered events after `after`, then live ones, in order and
        without duplicates, until the consumer stops iterating."""
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        entry = (asyncio.get_running_loop(), queue)
        with self._lock:
            # Register and snapshot under one lock so no event can fall between
            # "replayed" and "live".
            self._subscribers.setdefault(session_id, []).append(entry)
            backlog = [e for e in self._history.get(session_id, ()) if e["id"] > after]
        try:
            last = after
            for event in backlog:
                last = event["id"]
                yield event
            while True:
                event = await queue.get()
                if event["id"] <= last:
                    continue  # already delivered from the backlog
                last = event["id"]
                yield event
        finally:
            with self._lock:
                subscribers = self._subscribers.get(session_id, [])
                if entry in subscribers:
                    subscribers.remove(entry)
                if not subscribers:
                    self._subscribers.pop(session_id, None)

    def subscriber_count(self, session_id: str) -> int:
        with self._lock:
            return len(self._subscribers.get(session_id, ()))

    def forget(self, session_id: str) -> None:
        with self._lock:
            self._history.pop(session_id, None)
            self._counters.pop(session_id, None)


class RedisEventBus(EventBus):
    """The same bus, shared across instances through Redis.

    An event published by whichever instance handled the request reaches
    subscribers connected to any instance: ids come from a Redis counter, the
    replay buffer is a capped Redis list, and live delivery is pub/sub. If Redis
    becomes unreachable it degrades to the in-process bus (events then reach
    only subscribers of the same instance) rather than failing requests."""

    def __init__(self, url: str, replay: int = REPLAY_PER_SESSION, ttl_seconds: int = 3600) -> None:
        super().__init__(replay=replay)
        import redis

        self._url = url
        self._ttl = ttl_seconds
        self._client = redis.Redis.from_url(url, socket_timeout=2, socket_connect_timeout=2, decode_responses=True)

    @staticmethod
    def _keys(session_id: str) -> tuple[str, str, str]:
        return f"operon:ev:{session_id}:n", f"operon:ev:{session_id}:log", f"operon:ev:{session_id}:ch"

    def publish(self, session_id: str, event_type: str, **data: Any) -> dict[str, Any]:
        import json

        counter, log, channel = self._keys(session_id)
        try:
            number = int(self._client.incr(counter))
            event = {"id": number, "type": event_type, "at": datetime.now(UTC).isoformat(), **data}
            payload = json.dumps(event, default=str)
            pipe = self._client.pipeline()
            pipe.rpush(log, payload)
            pipe.ltrim(log, -self._replay, -1)
            for key in (counter, log):
                pipe.expire(key, self._ttl)
            pipe.publish(channel, payload)
            pipe.execute()
            return event
        except Exception as exc:  # noqa: BLE001 — never let the cache break a request
            logger.warning("event bus: redis unavailable (%s); using the in-process bus", type(exc).__name__)
            return super().publish(session_id, event_type, **data)

    def history(self, session_id: str, after: int = 0) -> list[dict[str, Any]]:
        import json

        try:
            rows = self._client.lrange(self._keys(session_id)[1], 0, -1)
            events = [json.loads(r) for r in rows]
        except Exception:  # noqa: BLE001
            return super().history(session_id, after)
        if not events:  # nothing (left) in Redis: whatever this instance remembers
            return super().history(session_id, after)
        return [e for e in events if e["id"] > after]

    async def subscribe(self, session_id: str, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        import json

        import redis.asyncio as aioredis

        client = aioredis.Redis.from_url(self._url, socket_timeout=None, socket_connect_timeout=2, decode_responses=True)
        pubsub = client.pubsub()
        try:
            await pubsub.subscribe(self._keys(session_id)[2])
        except Exception as exc:  # noqa: BLE001
            logger.warning("event bus: redis unavailable (%s); subscribing in-process", type(exc).__name__)
            await client.aclose()
            async for event in super().subscribe(session_id, after):
                yield event
            return
        try:
            last = after
            # Subscribed first, then replay: nothing can fall between the two.
            for event in self.history(session_id, after):
                last = event["id"]
                yield event
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message is None:
                    continue
                event = json.loads(message["data"])
                if event["id"] <= last:
                    continue  # already delivered from the replay
                last = event["id"]
                yield event
        finally:
            await pubsub.aclose()
            await client.aclose()


def _make_bus() -> EventBus:
    from operon_backend.config import settings

    if settings.redis_url:
        try:
            bus_ = RedisEventBus(settings.redis_url)
            bus_._client.ping()
            return bus_
        except Exception as exc:  # noqa: BLE001
            logger.warning("event bus: could not use redis (%s); using the in-process bus", type(exc).__name__)
    return EventBus()


bus = _make_bus()


def emit_stage(session_id: str, name: str, status: str, **data: Any) -> None:
    """A pipeline stage boundary, e.g. emit_stage(id, "diagnose", "started")."""
    bus.publish(session_id, STAGE, stage=name, status=status, **data)


def format_sse(event: dict[str, Any]) -> str:
    import json

    return f"id: {event['id']}\nevent: {event['type']}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n"


async def sse_stream(
    session_id: str,
    after: int = 0,
    *,
    is_terminal,
    is_disconnected,
    max_seconds: float = MAX_STREAM_SECONDS,
    heartbeat: float = HEARTBEAT_SECONDS,
    event_bus: EventBus | None = None,
) -> AsyncIterator[str]:
    """The SSE body for one subscriber. Ends when the session is terminal and
    the backlog is drained, when the client disconnects, or at `max_seconds`
    (a hard cap so an abandoned connection can't hold a worker forever).

    `is_terminal()` / `is_disconnected()` are callables so this stays testable
    without a real request object."""
    event_bus = event_bus or bus
    if await _maybe(is_terminal):
        # Nothing more will happen: replay what is buffered and close at once.
        for event in event_bus.history(session_id, after):
            after = event["id"]
            yield format_sse(event)
        yield format_sse({"id": after + 1, "type": END, "at": datetime.now(UTC).isoformat()})
        return
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max_seconds
    iterator = event_bus.subscribe(session_id, after).__aiter__()
    pending: asyncio.Task | None = None
    try:
        while True:
            if await _maybe(is_disconnected):
                return
            remaining = deadline - loop.time()
            if remaining <= 0:
                return
            if pending is None:
                pending = asyncio.ensure_future(iterator.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=min(heartbeat, remaining))
            if not done:
                yield ": heartbeat\n\n"
                if await _maybe(is_terminal) and not event_bus.history(session_id, after):
                    yield format_sse({"id": after + 1, "type": END, "at": datetime.now(UTC).isoformat()})
                    return
                continue
            try:
                event = pending.result()
            except StopAsyncIteration:
                return
            finally:
                pending = None
            after = max(after, event["id"])
            yield format_sse(event)
            if await _maybe(is_terminal):
                # Drain whatever is already buffered, then close.
                drained = False
                while not drained:
                    try:
                        nxt = await asyncio.wait_for(iterator.__anext__(), timeout=0.05)
                    except (TimeoutError, StopAsyncIteration):
                        drained = True
                    else:
                        after = max(after, nxt["id"])
                        yield format_sse(nxt)
                yield format_sse({"id": after + 1, "type": END, "at": datetime.now(UTC).isoformat()})
                return
    finally:
        if pending is not None:
            pending.cancel()
            try:
                await pending  # let the cancelled read finish before closing the iterator
            except BaseException:  # noqa: BLE001 — cancelled / exhausted; nothing to report
                pass
        await iterator.aclose()


async def _maybe(fn) -> bool:
    result = fn()
    if asyncio.iscoroutine(result):
        result = await result
    return bool(result)
