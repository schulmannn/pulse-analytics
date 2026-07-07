"""Data-invariant tests for the MTProto post builder (Operation «Ковчег»).

`mtproto/service.py` imports telethon / fastapi / uvicorn / dotenv at module load, which the CI
Python env need not have — so we stub them via sys.modules (the pattern CLAUDE.md prescribes) before
importing the module by path, then exercise the two pure invariants:

  * album (grouped_id) messages collapse into ONE logical post — no inflated post/view counts;
  * a collapsed album takes MAX views across its parts, never the sum (no double-count).
"""
import importlib.util
import sys
import types
import unittest
from pathlib import Path


def _install_stubs():
    def mod(name):
        m = types.ModuleType(name)
        sys.modules[name] = m
        return m

    # fastapi: FastAPI()/Body/Depends/... only need to be importable + callable at module load.
    fastapi = mod("fastapi")
    for attr in ("Body", "Depends", "FastAPI", "HTTPException", "Header", "Query", "Response"):
        setattr(fastapi, attr, lambda *a, **k: _Passthrough())
    responses = mod("fastapi.responses")
    responses.JSONResponse = object
    fastapi.responses = responses

    mod("uvicorn").run = lambda *a, **k: None

    telethon = mod("telethon")
    telethon.TelegramClient = object
    errors = mod("telethon.errors")
    for e in ("FloodWaitError", "PasswordHashInvalidError", "SessionPasswordNeededError"):
        setattr(errors, e, type(e, (Exception,), {}))
    telethon.errors = errors
    sessions = mod("telethon.sessions"); sessions.StringSession = object; telethon.sessions = sessions
    tl = mod("telethon.tl"); telethon.tl = tl
    functions = mod("telethon.tl.functions"); tl.functions = functions
    stats = mod("telethon.tl.functions.stats")
    for r in ("GetBroadcastStatsRequest", "LoadAsyncGraphRequest", "GetMessageStatsRequest"):
        setattr(stats, r, object)
    functions.stats = stats
    channels = mod("telethon.tl.functions.channels")
    for r in ("GetFullChannelRequest", "SearchPostsRequest", "CheckSearchPostsFloodRequest", "GetAdminedPublicChannelsRequest"):
        setattr(channels, r, object)
    functions.channels = channels
    tltypes = mod("telethon.tl.types")
    for t in ("StatsGraph", "StatsGraphAsync", "InputPeerEmpty", "PeerChannel"):
        setattr(tltypes, t, type(t, (), {}))
    tl.types = tltypes

    mod("dotenv").load_dotenv = lambda *a, **k: None


class _Passthrough:
    """FastAPI()/Depends() stand-in: usable as a decorator (returns the fn unchanged) and attr host."""
    def __call__(self, *a, **k):
        if len(a) == 1 and callable(a[0]) and not k:
            return a[0]
        return self
    def __getattr__(self, _):
        return self


def _load_service():
    _install_stubs()
    path = Path(__file__).resolve().parents[1] / "mtproto" / "service.py"
    spec = importlib.util.spec_from_file_location("mtproto_service_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Msg:
    """Minimal Telethon-message duck type for _logical_posts / _build_post."""
    def __init__(self, id, views, grouped_id=None, text=""):
        self.id = id
        self.views = views
        self.forwards = 0
        self.replies = None
        self.reactions = None
        self.grouped_id = grouped_id
        self.action = None
        self.text = text
        self.message = text
        self.pinned = False
        self.photo = self.video = self.document = self.poll = self.audio = self.voice = self.web_preview = None
        class _D:
            def isoformat(self_inner):
                return "2026-07-06T00:00:00+00:00"
        self.date = _D()


class AlbumInvariantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = _load_service()

    def test_album_collapses_to_one_logical_post(self):
        svc = self.svc
        # 3 messages share grouped_id=77 (an album) + 1 standalone post.
        msgs = [
            _Msg(101, 100, grouped_id=77, text="album caption"),
            _Msg(102, 50, grouped_id=77),
            _Msg(103, 30, grouped_id=77),
            _Msg(200, 500, text="standalone"),
        ]
        groups = svc._logical_posts(msgs)
        self.assertEqual(len(groups), 2, "album of 3 + 1 standalone → 2 logical posts, not 4")
        posts = [svc._build_post(g) for g in groups]

        album = next(p for p in posts if p["album_size"] > 0)
        self.assertEqual(album["album_size"], 3)
        self.assertEqual(album["views"], 100, "album views = MAX across parts, never the sum (no double-count)")
        self.assertEqual(album["id"], 101, "album id = the most-viewed message's id")

        standalone = next(p for p in posts if p["album_size"] == 0)
        self.assertEqual(standalone["views"], 500)
        self.assertEqual(standalone["id"], 200)

    def test_service_action_messages_are_dropped(self):
        svc = self.svc
        joined = _Msg(300, 0)
        joined.action = object()   # a service message (e.g. pinned/joined) — not a real post
        groups = svc._logical_posts([joined, _Msg(301, 10)])
        self.assertEqual(len(groups), 1, "service/action messages are excluded from post counts")


if __name__ == "__main__":
    unittest.main()
