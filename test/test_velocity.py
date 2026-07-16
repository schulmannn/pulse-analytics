"""Velocity tests for `mtproto/service.py`.

Covers the managed-central velocity release:

  * `_velocity_from_posts` — the SINGLE shared metric definition used by both GET /velocity and the
    managed POST /qr/collect: happy-path day-since-publish aggregation, the `top` cap, the
    "no eligible post settled yet" → available=False contract, and honest re-raise of
    TimeoutError / FloodWaitError (never swallowed into available=False);
  * POST /qr/collect opt-in: include_velocity defaults to False (ordinary QR channels pay NO
    GetMessageStats fanout, velocity is None) and only the explicit opt-in computes it, reusing the
    already-fetched entity + posts (a single get_messages);
  * total-budget cleanup: the _QR_COLLECT_SEM permit is released and the ephemeral client disconnected
    whether the collect succeeds or raises.

telethon / fastapi / uvicorn / dotenv are stubbed via sys.modules before importing the module by
path (the pattern CLAUDE.md prescribes). The plaintext session string is never asserted into any
output here.
"""
import asyncio
import base64
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

D = 86400000            # ms per day
T0 = 1700000000000      # arbitrary fixed epoch-ms bucket start (no wall-clock in tests)


class FloodWaitError(Exception):
    def __init__(self, *a, **k):
        super().__init__(*a)
        self.seconds = k.get('seconds', 0)


class UnauthorizedError(Exception):
    pass


class ChannelInvalidError(Exception):
    pass


class PeerChannel:
    def __init__(self, channel_id):
        self.channel_id = channel_id


class InputPeerChannel:
    def __init__(self, channel_id, access_hash):
        self.channel_id = channel_id
        self.access_hash = access_hash


# Distinct StatsGraph type so service's isinstance(g, StatsGraph) matches our fixture graphs.
StatsGraph = type("StatsGraph", (), {})
StatsGraphAsync = type("StatsGraphAsync", (), {})


class _ReqBase:
    """Records how a TL request was constructed; FakeClient.__call__ dispatches on the class name."""
    def __init__(self, *a, **k):
        self.a = a
        self.k = k


def _install_stubs():
    def mod(name):
        m = types.ModuleType(name)
        sys.modules[name] = m
        return m

    fastapi = mod("fastapi")
    for attr in ("Body", "Depends", "FastAPI", "Header", "Query", "Response"):
        setattr(fastapi, attr, lambda *a, **k: _Passthrough())

    class _StubHTTPException(Exception):
        def __init__(self, status_code=None, detail=None):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail
    fastapi.HTTPException = _StubHTTPException
    responses = mod("fastapi.responses")

    class _JSONResponse:
        def __init__(self, status_code=None, content=None):
            self.status_code = status_code
            self.content = content
    responses.JSONResponse = _JSONResponse
    fastapi.responses = responses

    mod("uvicorn").run = lambda *a, **k: None

    telethon = mod("telethon")
    telethon.TelegramClient = object
    errors = mod("telethon.errors")
    errors.FloodWaitError = FloodWaitError
    errors.UnauthorizedError = UnauthorizedError
    errors.ChannelInvalidError = ChannelInvalidError
    for e in ("PasswordHashInvalidError", "SessionPasswordNeededError"):
        setattr(errors, e, type(e, (Exception,), {}))
    telethon.errors = errors
    sessions = mod("telethon.sessions"); sessions.StringSession = lambda s='': s; telethon.sessions = sessions
    tl = mod("telethon.tl"); telethon.tl = tl
    functions = mod("telethon.tl.functions"); tl.functions = functions
    stats = mod("telethon.tl.functions.stats")
    for r in ("GetBroadcastStatsRequest", "LoadAsyncGraphRequest", "GetMessageStatsRequest"):
        setattr(stats, r, type(r, (_ReqBase,), {}))
    functions.stats = stats
    channels = mod("telethon.tl.functions.channels")
    for r in ("GetFullChannelRequest", "SearchPostsRequest", "CheckSearchPostsFloodRequest", "GetAdminedPublicChannelsRequest"):
        setattr(channels, r, type(r, (_ReqBase,), {}))
    functions.channels = channels
    tltypes = mod("telethon.tl.types")
    tltypes.StatsGraph = StatsGraph
    tltypes.StatsGraphAsync = StatsGraphAsync
    tltypes.InputPeerEmpty = type("InputPeerEmpty", (), {})
    tltypes.InputPeerChannel = InputPeerChannel
    tltypes.PeerChannel = PeerChannel
    tl.types = tltypes

    mod("dotenv").load_dotenv = lambda *a, **k: None


class _Passthrough:
    def __call__(self, *a, **k):
        if len(a) == 1 and callable(a[0]) and not k:
            return a[0]
        return self

    def __getattr__(self, _):
        return self


def _load_service():
    _install_stubs()
    path = Path(__file__).resolve().parents[1] / "mtproto" / "service.py"
    spec = importlib.util.spec_from_file_location("mtproto_service_velocity_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(coro):
    return asyncio.run(coro)


def _views_graph(buckets):
    """A StatsGraph fixture: incremental new-views per DAILY bucket, oldest-first (like Telegram)."""
    g = StatsGraph()
    xs = [T0 + i * D for i in range(len(buckets))]
    g.json = types.SimpleNamespace(data=json.dumps({
        "columns": [["x", *xs], ["y", *buckets]],
        "names": {"y": "Views"},
        "types": {"y": "line"},
    }))
    return g


class _MsgStats:
    def __init__(self, views_graph):
        self.views_graph = views_graph
        self.reactions_by_emotion_graph = None


class VelocityClient:
    """Minimal client for _velocity_from_posts: every call is a GetMessageStats round-trip.

    `results` is consumed in order — each item is either a _MsgStats (returned) or an Exception
    (raised, e.g. TimeoutError/FloodWait). Counts the round-trips so a test can assert the `top` cap
    and per-post reuse (one call per eligible post, no channel-wide refetch)."""
    def __init__(self, results):
        self.results = list(results)
        self.calls = 0

    async def __call__(self, req):
        self.calls += 1
        item = self.results.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def _post(pid, views):
    return {"id": pid, "views": views}


class VelocityFromPostsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = _load_service()

    def test_happy_path_aggregates_day_since_publish(self):
        svc = self.svc
        # One eligible post; daily buckets 50/30/20 (total 100) over 3 days → day1 50%, cum hits 80% on
        # day index 1 → t80_days = 2.
        tg = VelocityClient([_MsgStats(_views_graph([50, 30, 20]))])
        out = run(svc._velocity_from_posts(tg, object(), [_post(1, 1000)]))

        self.assertTrue(out["available"])
        self.assertEqual(out["posts_used"], 1)
        self.assertEqual(out["day1_share"], 50.0)
        self.assertEqual(out["t80_days"], 2)
        by_day = {d["day"]: d for d in out["by_day"]}
        self.assertEqual(by_day[0]["share"], 50.0)
        self.assertEqual(by_day[0]["cum"], 50.0)
        self.assertEqual(by_day[1]["cum"], 80.0)
        self.assertEqual(tg.calls, 1, "exactly one GetMessageStats per eligible post (reuses passed posts)")

    def test_contract_keys_present(self):
        svc = self.svc
        tg = VelocityClient([_MsgStats(_views_graph([60, 25, 15]))])
        out = run(svc._velocity_from_posts(tg, object(), [_post(1, 500)]))
        self.assertEqual(set(out), {"available", "posts_used", "by_day", "day1_share", "t80_days"})

    def test_top_cap_limits_the_getmessagestats_fanout(self):
        svc = self.svc
        # 15 eligible posts but top=3 → only 3 stats round-trips (the up-to-N fanout bound).
        posts = [_post(i, 1000) for i in range(15)]
        tg = VelocityClient([_MsgStats(_views_graph([50, 30, 20])) for _ in range(3)])
        out = run(svc._velocity_from_posts(tg, object(), posts, top=3))
        self.assertEqual(tg.calls, 3)
        self.assertEqual(out["posts_used"], 3)

    def test_ineligible_low_view_posts_are_skipped_before_any_rpc(self):
        svc = self.svc
        # All posts below the 80-view floor → NO GetMessageStats calls, available=False.
        tg = VelocityClient([])
        out = run(svc._velocity_from_posts(tg, object(), [_post(1, 10), _post(2, 79)]))
        self.assertEqual(out, {"available": False, "posts_used": 0})
        self.assertEqual(tg.calls, 0)

    def test_no_settled_post_returns_available_false_not_an_error(self):
        svc = self.svc
        # Eligible by views, but the lifecycle is too young (single bucket / <2 days) → skipped, and
        # with nothing usable the honest answer is a 200-style available=False, NOT an exception.
        tg = VelocityClient([_MsgStats(_views_graph([100, 5]))])   # spans <2 full days → last_d < 2
        out = run(svc._velocity_from_posts(tg, object(), [_post(1, 1000)]))
        self.assertEqual(out, {"available": False, "posts_used": 0})

    def test_timeout_is_reraised_not_swallowed(self):
        svc = self.svc
        tg = VelocityClient([asyncio.TimeoutError()])
        with self.assertRaises(asyncio.TimeoutError):
            run(svc._velocity_from_posts(tg, object(), [_post(1, 1000)]))

    def test_floodwait_is_reraised_not_swallowed(self):
        svc = self.svc
        tg = VelocityClient([FloodWaitError(seconds=30)])
        with self.assertRaises(FloodWaitError):
            run(svc._velocity_from_posts(tg, object(), [_post(1, 1000)]))

    def test_generic_per_post_rpc_failure_is_skipped(self):
        svc = self.svc
        # First post's stats RPC raises a generic error (skipped); the second yields a usable graph.
        tg = VelocityClient([RuntimeError("MSG_ID_INVALID"), _MsgStats(_views_graph([50, 30, 20]))])
        out = run(svc._velocity_from_posts(tg, object(), [_post(1, 1000), _post(2, 1000)]))
        self.assertTrue(out["available"])
        self.assertEqual(out["posts_used"], 1)
        self.assertEqual(tg.calls, 2)


# ── POST /qr/collect opt-in + total-budget cleanup ──────────────────────────────────────────────

class _Date:
    def isoformat(self):
        return "2026-07-15T10:00:00+00:00"


class FakeMsg:
    """Just enough of a Telethon message for _logical_posts + _build_post."""
    def __init__(self, mid, views):
        self.id = mid
        self.views = views
        self.forwards = 0
        self.replies = None
        self.reactions = None
        self.text = "hello #tag"
        self.message = "hello #tag"
        self.date = _Date()
        self.pinned = False
        self.action = None
        self.grouped_id = None
        self.photo = self.video = self.document = None
        self.poll = self.audio = self.voice = self.web_preview = None


class _Entity:
    id = -1001234567890
    access_hash = None


class _Full:
    def __init__(self):
        self.chats = [types.SimpleNamespace(id=-1001234567890, title="Chan", username="chan")]
        self.full_chat = types.SimpleNamespace(about="", participants_count=10, admins_count=1, online_count=0)


class QrClient:
    """Ephemeral-collect client stub. Dispatches TL requests by class name; records get_messages and
    GetMessageStats counts + whether disconnect ran (for the semaphore/client cleanup assertion)."""
    def __init__(self, messages, msgstats, *, authorized=True, photo=None):
        self.messages = messages
        self.msgstats = msgstats           # _MsgStats, an Exception, or None
        self.authorized = authorized
        self.photo = photo
        self.get_messages_calls = 0
        self.msgstats_calls = 0
        self.disconnected = False
        self._connected = True

    def is_connected(self):
        return self._connected

    async def connect(self):
        return True

    async def is_user_authorized(self):
        return self.authorized

    async def get_entity(self, ref):
        return _Entity()

    async def get_messages(self, entity, limit=0):
        self.get_messages_calls += 1
        return self.messages

    async def download_profile_photo(self, entity, file=bytes):
        if isinstance(self.photo, BaseException):
            raise self.photo
        return self.photo

    async def disconnect(self):
        self.disconnected = True
        self._connected = False

    async def __call__(self, req):
        name = type(req).__name__
        if name == "GetBroadcastStatsRequest":
            return types.SimpleNamespace()       # small channel; graph attrs default to None
        if name == "GetFullChannelRequest":
            return _Full()
        if name == "GetMessageStatsRequest":
            self.msgstats_calls += 1
            if isinstance(self.msgstats, BaseException):
                raise self.msgstats
            return self.msgstats
        raise AssertionError(f"unexpected request {name}")


def _configure(svc, client):
    svc.MTPROTO_TOKEN = "tok"
    svc.API_ID = 123
    svc.API_HASH = "hash"
    svc.TelegramClient = lambda *a, **k: client
    svc.StringSession = lambda s='': s


class QrCollectVelocityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = _load_service()

    def _call(self, client, **kw):
        svc = self.svc
        _configure(svc, client)
        # Pass every Body/Header param explicitly: called outside FastAPI, the stubbed Body(default=…)
        # yields a passthrough sentinel, so int(posts_limit or 100) would choke on the default.
        params = dict(session="SECRET-SESSION", channel="chan", posts_limit=100,
                      graph_points=400, access_hash=None, include_velocity=False,
                      include_media=False,
                      x_internal_token="tok")
        params.update(kw)
        return run(svc.qr_collect(**params))

    def test_default_omits_velocity_and_pays_no_fanout(self):
        svc = self.svc
        client = QrClient([FakeMsg(1, 1000)], _MsgStats(_views_graph([50, 30, 20])))
        out = self._call(client)   # include_velocity defaults to False

        self.assertIsNone(out["velocity"], "ordinary QR collect carries no velocity payload")
        self.assertEqual(client.msgstats_calls, 0, "no GetMessageStats fanout when velocity not requested")
        self.assertEqual(client.get_messages_calls, 1)
        self.assertEqual(svc._QR_COLLECT_SEM._value, svc._QR_COLLECT_MAX, "semaphore permit released")
        self.assertTrue(client.disconnected, "ephemeral client disconnected")

    def test_opt_in_computes_velocity_reusing_the_fetched_posts(self):
        svc = self.svc
        client = QrClient([FakeMsg(1, 1000)], _MsgStats(_views_graph([50, 30, 20])))
        out = self._call(client, include_velocity=True)

        self.assertTrue(out["velocity"]["available"])
        self.assertEqual(out["velocity"]["posts_used"], 1)
        self.assertEqual(client.get_messages_calls, 1, "velocity reuses the already-fetched posts (no refetch)")
        self.assertEqual(client.msgstats_calls, 1, "one stats round-trip for the one eligible post")
        self.assertEqual(svc._QR_COLLECT_SEM._value, svc._QR_COLLECT_MAX)
        self.assertTrue(client.disconnected)

    def test_opt_in_no_eligible_posts_is_available_false(self):
        svc = self.svc
        client = QrClient([FakeMsg(1, 10)], None)   # below the 80-view floor
        out = self._call(client, include_velocity=True)
        self.assertEqual(out["velocity"], {"available": False, "posts_used": 0})
        self.assertEqual(client.msgstats_calls, 0)

    def test_velocity_timeout_fails_the_bundle_and_still_releases_the_semaphore(self):
        svc = self.svc
        client = QrClient([FakeMsg(1, 1000)], asyncio.TimeoutError())
        with self.assertRaises(svc.HTTPException) as ctx:
            self._call(client, include_velocity=True)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(ctx.exception.detail, "mtproto_timeout")
        self.assertEqual(svc._QR_COLLECT_SEM._value, svc._QR_COLLECT_MAX, "permit released on the error path")
        self.assertTrue(client.disconnected, "client disconnected on the error path")

    def test_include_media_captures_bounded_channel_photo_as_top_level_base64(self):
        photo = b"\xff\xd8\x01\x02"
        client = QrClient([FakeMsg(1, 10)], None, photo=photo)
        out = self._call(client, include_media=True)
        self.assertEqual(out["channel_photo"], base64.b64encode(photo).decode("ascii"))
        self.assertNotIn("channel_photo", out["channel"], "blob must not ride the public channel object")
        self.assertTrue(client.disconnected)
        self.assertEqual(self.svc._QR_COLLECT_SEM._value, self.svc._QR_COLLECT_MAX)

    def test_channel_photo_failure_or_non_jpeg_never_fails_core_bundle(self):
        for photo in (RuntimeError("download failed"), b"not-a-jpeg"):
            client = QrClient([FakeMsg(1, 10)], None, photo=photo)
            out = self._call(client, include_media=True)
            self.assertIsNone(out["channel_photo"])
            self.assertIn("channel", out)
            self.assertTrue(client.disconnected)


class QrPostStatsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = _load_service()

    def _call(self, client, **overrides):
        svc = self.svc
        _configure(svc, client)
        params = dict(session="SECRET-SESSION", channel="chan", msg_id=77,
                      access_hash=None, x_internal_token="tok")
        params.update(overrides)
        return run(svc.qr_post_stats(**params))

    def test_managed_post_stats_reuses_canonical_parser_and_returns_entity_binding(self):
        client = QrClient([], _MsgStats(_views_graph([5, 7, 9])))
        out = self._call(client)
        self.assertTrue(out["available"])
        self.assertEqual(out["views_graph"]["x"], [T0, T0 + D, T0 + 2 * D])
        self.assertEqual(out["entity"]["id"], str(_Entity.id))
        self.assertNotIn("session", out)
        self.assertTrue(client.disconnected)
        self.assertEqual(self.svc._QR_COLLECT_SEM._value, self.svc._QR_COLLECT_MAX)

    def test_unavailable_post_is_honest_200_with_entity_and_cleanup(self):
        client = QrClient([], RuntimeError("not enough stats"))
        out = self._call(client)
        self.assertFalse(out["available"])
        self.assertEqual(out["entity"]["id"], str(_Entity.id))
        self.assertTrue(client.disconnected)

    def test_unauthorized_managed_session_is_401_and_releases_bulkhead(self):
        client = QrClient([], None, authorized=False)
        with self.assertRaises(self.svc.HTTPException) as ctx:
            self._call(client)
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertEqual(ctx.exception.detail, "session_unauthorized")
        self.assertTrue(client.disconnected)
        self.assertEqual(self.svc._QR_COLLECT_SEM._value, self.svc._QR_COLLECT_MAX)

    def test_stats_timeout_is_503_and_releases_bulkhead(self):
        client = QrClient([], asyncio.TimeoutError())
        with self.assertRaises(self.svc.HTTPException) as ctx:
            self._call(client)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(ctx.exception.detail, "mtproto_timeout")
        self.assertTrue(client.disconnected)
        self.assertEqual(self.svc._QR_COLLECT_SEM._value, self.svc._QR_COLLECT_MAX)


if __name__ == "__main__":
    unittest.main()
