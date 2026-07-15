"""Managed QR-collection entity-resolution tests for `mtproto/service.py`.

Covers the access_hash warm path added to fix the finding that `/qr/collect` scanned
iter_dialogs(limit=1000) on every collect of a PRIVATE channel just to recover the access_hash from
a fresh StringSession's entity cache:

  * WARM: a persisted access_hash resolves the channel directly (InputPeerChannel) — NO dialog scan;
  * COLD: a legacy row with no hash falls back to a ONE-TIME dialog resync, then retries by id;
  * SELF-HEAL: a stale/invalid hash falls through to the same one-time resync (at most once);
  * a genuine auth error (UnauthorizedError) on the warm attempt propagates, never a silent scan;
  * a username ref resolves directly and never touches InputPeerChannel or dialogs;
  * int64 access_hash / id values parse and serialize BYTE-EXACT (never through a float/JS Number).

telethon / fastapi / uvicorn / dotenv are stubbed via sys.modules before importing the module by
path (the pattern CLAUDE.md prescribes), with FUNCTIONAL PeerChannel/InputPeerChannel so isinstance
and the id/access_hash attributes behave like the real TL types.
"""
import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path


class PeerChannel:
    def __init__(self, channel_id):
        self.channel_id = channel_id


class InputPeerChannel:
    def __init__(self, channel_id, access_hash):
        self.channel_id = channel_id
        self.access_hash = access_hash


class FloodWaitError(Exception):
    pass


class UnauthorizedError(Exception):
    pass


class ChannelInvalidError(Exception):
    pass


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
    responses.JSONResponse = object
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
    tltypes.StatsGraph = type("StatsGraph", (), {})
    tltypes.StatsGraphAsync = type("StatsGraphAsync", (), {})
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
    spec = importlib.util.spec_from_file_location("mtproto_service_resolve_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Chan:
    def __init__(self, id, access_hash):
        self.id = id
        self.access_hash = access_hash


class FakeClient:
    """Minimal Telethon client duck type for _resolve_channel_entity."""

    def __init__(self, entity):
        self.entity = entity
        self.username_result = entity
        self.warm_result = "ok"          # "ok" → return entity; an Exception instance → raise it
        self.iter_dialogs_calls = 0
        self.get_entity_refs = []
        self._dialogs_synced = False

    async def get_entity(self, ref):
        self.get_entity_refs.append(ref)
        if isinstance(ref, str):
            return self.username_result
        if isinstance(ref, InputPeerChannel):
            if isinstance(self.warm_result, BaseException):
                raise self.warm_result
            return self.entity
        if isinstance(ref, PeerChannel):
            # A bare-id peer has no cached access_hash until a dialog sync populates it.
            if self._dialogs_synced:
                return self.entity
            raise ValueError("CHANNEL_PRIVATE_no_access_hash")
        raise AssertionError(f"unexpected ref {ref!r}")

    async def _empty_dialogs(self):
        self._dialogs_synced = True
        for _ in ():
            yield None

    def iter_dialogs(self, **_kw):
        self.iter_dialogs_calls += 1
        return self._empty_dialogs()


def run(coro):
    return asyncio.run(coro)


class ResolveEntityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = _load_service()

    def test_warm_path_skips_dialog_scan(self):
        svc = self.svc
        c = FakeClient(_Chan(-1001234567890, 7345987012345678901))
        ent = run(svc._resolve_channel_entity(c, PeerChannel(-1001234567890), "7345987012345678901"))

        self.assertIs(ent, c.entity)
        self.assertEqual(c.iter_dialogs_calls, 0, "a stored access_hash must resolve WITHOUT a dialog scan")
        first = c.get_entity_refs[0]
        self.assertIsInstance(first, InputPeerChannel)
        self.assertEqual(first.access_hash, 7345987012345678901, "int64 hash parsed exactly (no float)")

    def test_cold_legacy_row_syncs_dialogs_once_then_resolves(self):
        svc = self.svc
        c = FakeClient(_Chan(-1009876543210, -8674665223082153551))
        ent = run(svc._resolve_channel_entity(c, PeerChannel(-1009876543210), None))

        self.assertIs(ent, c.entity)
        self.assertEqual(c.iter_dialogs_calls, 1, "no stored hash → exactly ONE dialog resync")
        self.assertFalse(any(isinstance(r, InputPeerChannel) for r in c.get_entity_refs))

    def test_stale_hash_self_heals_via_one_resync(self):
        svc = self.svc
        c = FakeClient(_Chan(-1001111111111, 42))
        c.warm_result = ChannelInvalidError("CHANNEL_INVALID")   # stored hash is stale
        ent = run(svc._resolve_channel_entity(c, PeerChannel(-1001111111111), "111"))

        self.assertIs(ent, c.entity)
        self.assertEqual(c.iter_dialogs_calls, 1, "stale hash falls back to the resync AT MOST once")
        # It DID try the warm InputPeerChannel first, then recovered via a bare-id retry.
        self.assertIsInstance(c.get_entity_refs[0], InputPeerChannel)

    def test_auth_error_on_warm_path_propagates_without_a_scan(self):
        svc = self.svc
        c = FakeClient(_Chan(-100, 1))
        c.warm_result = UnauthorizedError("AUTH_KEY_UNREGISTERED")
        with self.assertRaises(UnauthorizedError):
            run(svc._resolve_channel_entity(c, PeerChannel(-100), "1"))
        self.assertEqual(c.iter_dialogs_calls, 0, "a genuine auth error must NOT trigger a dialog scan")

    def test_floodwait_on_warm_path_propagates_without_a_scan(self):
        svc = self.svc
        c = FakeClient(_Chan(-100, 1))
        c.warm_result = FloodWaitError("FLOOD")
        with self.assertRaises(FloodWaitError):
            run(svc._resolve_channel_entity(c, PeerChannel(-100), "1"))
        self.assertEqual(c.iter_dialogs_calls, 0)

    def test_transient_connection_error_propagates_without_a_scan(self):
        svc = self.svc
        c = FakeClient(_Chan(-100, 1))
        c.warm_result = ConnectionError("temporary network failure")
        with self.assertRaises(ConnectionError):
            run(svc._resolve_channel_entity(c, PeerChannel(-100), "1"))
        self.assertEqual(c.iter_dialogs_calls, 0, "a transport failure is not a stale entity hash")

    def test_username_resolves_directly(self):
        svc = self.svc
        c = FakeClient(_Chan(123, 456))
        ent = run(svc._resolve_channel_entity(c, "mychannel", "999"))
        self.assertIs(ent, c.username_result)
        self.assertEqual(c.iter_dialogs_calls, 0)
        self.assertIsInstance(c.get_entity_refs[0], str)
        self.assertFalse(any(isinstance(r, InputPeerChannel) for r in c.get_entity_refs))

    def test_channel_ref_maps_numeric_to_peerchannel_and_username_to_str(self):
        svc = self.svc
        ref = svc._channel_ref("-1001234567890")
        self.assertIsInstance(ref, PeerChannel)
        self.assertEqual(ref.channel_id, -1001234567890)
        self.assertEqual(svc._channel_ref("@brand"), "brand")


class ParseAndSerializeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = _load_service()

    def test_parse_access_hash_exact_int64(self):
        svc = self.svc
        self.assertEqual(svc._parse_access_hash("9223372036854775807"), 9223372036854775807)
        self.assertEqual(svc._parse_access_hash("-8674665223082153551"), -8674665223082153551)
        self.assertEqual(svc._parse_access_hash(" 12345 "), 12345)
        self.assertEqual(svc._parse_access_hash(12345), 12345)
        self.assertIsNone(svc._parse_access_hash("9223372036854775808"))
        self.assertIsNone(svc._parse_access_hash("-9223372036854775809"))

    def test_parse_access_hash_rejects_garbage_and_blank(self):
        svc = self.svc
        self.assertIsNone(svc._parse_access_hash(None))
        self.assertIsNone(svc._parse_access_hash(""))
        self.assertIsNone(svc._parse_access_hash("   "))
        self.assertIsNone(svc._parse_access_hash("not-a-number"))

    def test_entity_identity_serializes_int64_as_exact_strings(self):
        svc = self.svc
        out = svc._entity_identity(_Chan(-1001234567890, 9223372036854775807))
        self.assertEqual(out, {"id": "-1001234567890", "access_hash": "9223372036854775807"})
        # The exact same digits survive — a JS/JSON float round-trip would corrupt this value.
        self.assertEqual(out["access_hash"], "9223372036854775807")

    def test_entity_identity_handles_missing_access_hash(self):
        svc = self.svc
        out = svc._entity_identity(_Chan(555, None))
        self.assertEqual(out, {"id": "555", "access_hash": None})


if __name__ == "__main__":
    unittest.main()
