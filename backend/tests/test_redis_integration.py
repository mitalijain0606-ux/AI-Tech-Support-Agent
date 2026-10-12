"""Redis, for real: a shared rate-limit budget across instances, key expiry,
selection from REDIS_URL, and graceful behaviour when Redis goes away."""

import time

import pytest

import db_support
from operon_backend import ratelimit
from operon_backend.config import settings
from operon_backend.ratelimit import RateLimiter


@pytest.fixture
def redis_client():
    import redis

    client = redis.Redis.from_url(db_support.redis_url(), decode_responses=True)
    client.flushdb()
    yield client
    client.flushdb()


def test_two_instances_share_one_budget(redis_client):
    a, b = RateLimiter(redis_client), RateLimiter(redis_client)
    results = [a.hit("caller", 4)[0], b.hit("caller", 4)[0], a.hit("caller", 4)[0], b.hit("caller", 4)[0], a.hit("caller", 4)[0]]
    assert results == [True, True, True, True, False]
    allowed, retry_after = b.hit("caller", 4)
    assert not allowed and 1 <= retry_after <= ratelimit.WINDOW_SECONDS


def test_counters_expire_on_their_own(redis_client):
    RateLimiter(redis_client).hit("caller", 4)
    keys = redis_client.keys("operon:rl:caller:*")
    assert len(keys) == 1 and 0 < redis_client.ttl(keys[0]) <= ratelimit.WINDOW_SECONDS * 2


def test_the_window_rolls_over(redis_client):
    now = [int(time.time()) // ratelimit.WINDOW_SECONDS * ratelimit.WINDOW_SECONDS + 5]
    lim = RateLimiter(redis_client, clock=lambda: now[0])
    assert lim.hit("k", 1)[0] and not lim.hit("k", 1)[0]
    now[0] += ratelimit.WINDOW_SECONDS  # the next window
    assert lim.hit("k", 1)[0]


def test_redis_url_selects_the_redis_limiter(redis_client, monkeypatch):
    monkeypatch.setattr(settings, "redis_url", db_support.redis_url())
    made = ratelimit._make_limiter()
    assert made._redis is not None
    made.hit("selected", 5)
    assert redis_client.keys("operon:rl:selected:*")


def test_an_unusable_redis_url_falls_back_to_the_in_process_limiter(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", "not-a-url")
    made = ratelimit._make_limiter()
    assert made.hit("k", 1) == (True, 0)  # still limits, in memory
    assert made.hit("k", 1)[0] is False


def test_a_redis_outage_mid_flight_does_not_take_the_api_down(redis_client, caplog):
    lim = RateLimiter(redis_client)
    assert lim.hit("k", 1)[0]
    redis_client.connection_pool.disconnect()
    lim._redis = type("Gone", (), {"pipeline": lambda self: (_ for _ in ()).throw(ConnectionError("gone"))})()
    assert lim.hit("k", 1) == (True, 0)
    assert "redis unavailable" in caplog.text


# ---- the shared event bus ---------------------------------------------------------------------------------------------


def test_an_event_published_on_one_instance_reaches_a_subscriber_on_another(redis_client):
    import asyncio

    from operon_backend.events import RedisEventBus

    url = db_support.redis_url()

    async def go():
        instance_a, instance_b = RedisEventBus(url), RedisEventBus(url)
        instance_a.publish("s", "stage", stage="before", status="started")  # published before anyone listens
        got = []

        async def consume():
            async for event in instance_b.subscribe("s"):
                got.append(event["stage"])
                if len(got) == 3:
                    return

        task = asyncio.ensure_future(consume())
        await asyncio.sleep(0.3)
        instance_a.publish("s", "stage", stage="live-1", status="started")
        instance_a.publish("s", "stage", stage="live-2", status="started")
        await asyncio.wait_for(task, 5)
        return got

    assert asyncio.run(go()) == ["before", "live-1", "live-2"]  # replay first, then live, in order, no duplicates


def test_ids_are_shared_and_the_replay_buffer_is_capped(redis_client):
    from operon_backend.events import RedisEventBus

    a, b = RedisEventBus(db_support.redis_url(), replay=5), RedisEventBus(db_support.redis_url(), replay=5)
    ids = [(a if i % 2 else b).publish("s", "stage", stage=str(i), status="started")["id"] for i in range(12)]
    assert ids == list(range(1, 13))  # one numbering across both instances
    kept = a.history("s")
    assert [e["id"] for e in kept] == [8, 9, 10, 11, 12]
    assert [e["id"] for e in b.history("s", after=10)] == [11, 12]
    assert redis_client.ttl("operon:ev:s:log") > 0  # abandoned sessions clean themselves up


def test_the_event_bus_degrades_to_in_process_when_redis_is_unreachable(caplog):
    from operon_backend.events import RedisEventBus

    bus = RedisEventBus("redis://127.0.0.1:1/0")
    event = bus.publish("s", "stage", stage="x", status="started")
    assert event["id"] == 1 and bus.history("s")[0]["stage"] == "x"
    assert "redis unavailable" in caplog.text
