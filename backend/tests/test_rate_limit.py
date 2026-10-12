"""Rate limiting: the limiter itself (memory and Redis-shaped), the 429
contract, per-caller budgets, the LLM budget and the failed-login throttle."""

from starlette.testclient import TestClient

from auth_helpers import mint
from flow_helpers import CAPABILITIES
from operon_backend.config import settings
from operon_backend.main import app
from operon_backend.ratelimit import WINDOW_SECONDS, RateLimiter, limiter

client = TestClient(app)
NEW = {"user_issue": "my dashboard is broken", "provider_capabilities": CAPABILITIES}


class Clock:
    def __init__(self, now=1_000.0):
        self.now = now

    def __call__(self):
        return self.now


# ---- the limiter ----------------------------------------------------------------------------------------


def test_requests_within_the_budget_pass_and_the_next_is_refused_with_a_retry_hint():
    clock = Clock()
    lim = RateLimiter(clock=clock)
    assert [lim.hit("k", 3)[0] for _ in range(3)] == [True, True, True]
    allowed, retry_after = lim.hit("k", 3)
    assert not allowed and 1 <= retry_after <= WINDOW_SECONDS


def test_the_budget_frees_up_as_the_window_slides():
    clock = Clock()
    lim = RateLimiter(clock=clock)
    for _ in range(2):
        lim.hit("k", 2)
    assert not lim.hit("k", 2)[0]
    clock.now += WINDOW_SECONDS + 1
    assert lim.hit("k", 2)[0]


def test_callers_do_not_share_a_budget():
    lim = RateLimiter(clock=Clock())
    lim.hit("a", 1)
    assert not lim.hit("a", 1)[0] and lim.hit("b", 1)[0]


def test_a_non_positive_limit_disables_limiting():
    lim = RateLimiter(clock=Clock())
    assert all(lim.hit("k", 0)[0] for _ in range(50))


def test_memory_stays_bounded_under_key_churn():
    clock = Clock()
    lim = RateLimiter(clock=clock)
    for i in range(12_000):
        lim.hit(f"k{i}", 5)
    clock.now += WINDOW_SECONDS + 1
    lim.hit("fresh", 5)
    assert len(lim._hits) < 12_000


class FakeRedis:
    """Just enough of redis-py's pipeline for the limiter."""

    def __init__(self):
        self.counts = {}
        self.ttls = {}

    def pipeline(self):
        outer = self

        class Pipe:
            def __init__(self):
                self.ops = []

            def incr(self, name):
                self.ops.append(("incr", name))

            def expire(self, name, seconds):
                self.ops.append(("expire", name, seconds))

            def execute(self):
                out = []
                for op in self.ops:
                    if op[0] == "incr":
                        outer.counts[op[1]] = outer.counts.get(op[1], 0) + 1
                        out.append(outer.counts[op[1]])
                    else:
                        outer.ttls[op[1]] = op[2]
                        out.append(True)
                return out

        return Pipe()


def test_the_redis_backed_limiter_shares_one_budget_across_instances():
    shared = FakeRedis()
    clock = Clock()
    a, b = RateLimiter(shared, clock=clock), RateLimiter(shared, clock=clock)  # two app instances
    assert a.hit("k", 2)[0] and b.hit("k", 2)[0]
    allowed, retry_after = a.hit("k", 2)
    assert not allowed and 1 <= retry_after <= WINDOW_SECONDS
    assert all(ttl > WINDOW_SECONDS for ttl in shared.ttls.values())  # keys expire on their own


def test_an_unreachable_redis_fails_open_rather_than_taking_the_api_down(caplog):
    class Down:
        def pipeline(self):
            raise ConnectionError("redis is down")

    lim = RateLimiter(Down(), clock=Clock())
    assert lim.hit("k", 1) == (True, 0) and lim.hit("k", 1) == (True, 0)
    assert "redis unavailable" in caplog.text


# ---- over HTTP ---------------------------------------------------------------------------------------------------------


def test_the_api_answers_429_with_retry_after_when_a_caller_exceeds_their_budget(monkeypatch):
    monkeypatch.setattr(settings, "auth_required", True)
    monkeypatch.setattr(settings, "rate_limit_per_minute", 3)
    headers = mint("acme", "alice")
    codes = [client.post("/api/sessions", json=NEW, headers=headers).status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    refused = client.post("/api/sessions", json=NEW, headers=headers)
    assert refused.headers["retry-after"].isdigit() and "Rate limit" in refused.json()["detail"]
    other = mint("acme", "bob")  # a different caller is unaffected
    assert client.post("/api/sessions", json=NEW, headers=other).status_code == 200


def test_the_llm_endpoints_have_their_own_lower_budget(monkeypatch):
    monkeypatch.setattr(settings, "auth_required", True)
    monkeypatch.setattr(settings, "rate_limit_llm_per_minute", 2)
    headers = mint("acme", "alice")
    sid = client.post("/api/sessions", json=NEW, headers=headers).json()["session_id"]
    body = {"bundle": {"url": "u", "timestamp": 1, "request_id": "req_wrong"}}
    codes = [client.post(f"/api/sessions/{sid}/investigate", json=body, headers=headers).status_code for _ in range(4)]
    assert codes[:2] == [409, 409] and codes[2:] == [429, 429]  # the first two reached the handler
    assert client.get(f"/api/sessions/{sid}", headers=headers).status_code == 200  # reads use the general budget


def test_repeated_failed_authentication_is_throttled_per_client(monkeypatch):
    monkeypatch.setattr(settings, "auth_required", True)
    monkeypatch.setattr(settings, "rate_limit_auth_failures_per_minute", 3)
    bad = {"Authorization": "Bearer opk_wrong"}
    codes = [client.post("/api/sessions", json=NEW, headers=bad).status_code for _ in range(5)]
    assert codes == [401, 401, 401, 429, 429]
    # A throttled client is refused even with a valid key? No: valid keys never count as failures.
    assert client.post("/api/sessions", json=NEW, headers=mint("acme", "alice")).status_code == 200


def test_forwarded_for_is_only_trusted_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "auth_required", True)
    monkeypatch.setattr(settings, "rate_limit_auth_failures_per_minute", 2)
    bad = {"Authorization": "Bearer opk_wrong"}

    def attempt(forwarded):
        return client.post("/api/sessions", json=NEW, headers={**bad, "X-Forwarded-For": forwarded}).status_code

    monkeypatch.setattr(settings, "trust_forwarded_for", False)
    assert [attempt(f"10.0.0.{i}") for i in range(4)] == [401, 401, 429, 429]  # spoofing the header buys nothing
    limiter.reset()
    monkeypatch.setattr(settings, "trust_forwarded_for", True)
    assert [attempt(f"10.0.0.{i}") for i in range(4)] == [401, 401, 401, 401]  # a trusted proxy's view of distinct clients


def test_a_client_cannot_forge_its_address_behind_a_trusted_proxy(monkeypatch):
    """The proxy appends the real address on the right; whatever the client put on
    the left is ignored, so rotating a fake first entry does not dodge the throttle."""
    monkeypatch.setattr(settings, "auth_required", True)
    monkeypatch.setattr(settings, "trust_forwarded_for", True)
    monkeypatch.setattr(settings, "rate_limit_auth_failures_per_minute", 2)
    bad = {"Authorization": "Bearer opk_wrong"}
    codes = [client.post("/api/sessions", json=NEW, headers={**bad, "X-Forwarded-For": f"6.6.6.{i}, 203.0.113.9"}).status_code for i in range(4)]
    assert codes == [401, 401, 429, 429]  # always the same real client, 203.0.113.9


def test_the_number_of_trusted_hops_is_configurable(monkeypatch):
    from starlette.requests import Request

    from operon_backend.auth import client_ip

    def request(forwarded):
        return Request({"type": "http", "headers": [(b"x-forwarded-for", forwarded.encode())], "client": ("10.1.1.1", 1)})

    monkeypatch.setattr(settings, "trust_forwarded_for", True)
    monkeypatch.setattr(settings, "trusted_proxy_hops", 2)
    assert client_ip(request("1.1.1.1, 2.2.2.2, 3.3.3.3")) == "2.2.2.2"
    assert client_ip(request("3.3.3.3")) == "10.1.1.1"  # fewer hops than trusted: fall back to the socket peer
    monkeypatch.setattr(settings, "trust_forwarded_for", False)
    assert client_ip(request("1.1.1.1, 2.2.2.2")) == "10.1.1.1"
