"""Focused tests for the narrow cover-repair endpoint (POST /qr/media) in `mtproto/service.py`.

The 15-min recovery lane asks this endpoint for the EXACT post ids whose small cover is still missing,
so a genuinely thumbless post is never re-scanned through the heavy /qr/collect pipeline. Covers:

  * `_clean_media_ids`: decimal-string parse, dedup, positive/int64-range guard, hard count cap, non-list;
  * `_collect_media_by_id`: mixed photo/video/no-media/no-thumb outcomes, JPEG + byte bounds, total-byte
    ceiling, per-download timeout isolation and FloodWait isolation (fewer covers, never a raise);
  * the endpoint: auth/config/session/msg_ids validation, unauthorized-session 401, a mixed success that
    returns only real covers plus the resolved entity identity, and semaphore/client cleanup.

telethon / fastapi / uvicorn / dotenv are stubbed via sys.modules before importing the module by path
(the pattern CLAUDE.md prescribes), mirroring test_qr_collect_resolve.py.
"""
import asyncio
import base64
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
    def __init__(self, *a, seconds=3, **k):
        super().__init__(*a)
        self.seconds = seconds


class UnauthorizedError(Exception):
    pass


class ChannelInvalidError(Exception):
    pass


class _StubHTTPException(Exception):
    def __init__(self, status_code=None, detail=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _install_stubs():
    def mod(name):
        m = types.ModuleType(name)
        sys.modules[name] = m
        return m

    fastapi = mod("fastapi")
    for attr in ("Body", "Depends", "FastAPI", "Header", "Query", "Response"):
        setattr(fastapi, attr, lambda *a, **k: _Passthrough())
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
    spec = importlib.util.spec_from_file_location("mtproto_service_media_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(coro):
    return asyncio.run(coro)


class _MediaMessage:
    def __init__(self, msg_id, *, photo=False, video=False):
        self.id = msg_id
        self.photo = object() if photo else None
        self.video = object() if video else None
        self.document = None


class _ThumbClient:
    """Duck type for _download_thumb_bytes → download_media, driven by {id: bytes|None} + optional delay."""

    def __init__(self, payloads, delay=0):
        self.payloads = payloads
        self.delay = delay
        self.calls = []

    async def download_media(self, msg, thumb=None, file=None):
        self.calls.append((msg.id, thumb))
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.payloads.get(msg.id)


class _IndexedThumbClient:
    """Telethon-like thumb candidates keyed by (message id, thumb index)."""

    def __init__(self, payloads):
        self.payloads = payloads
        self.calls = []

    async def download_media(self, msg, thumb=None, file=None):
        self.calls.append((msg.id, thumb))
        value = self.payloads.get((msg.id, thumb))
        if isinstance(value, Exception):
            raise value
        return value


class _Entity:
    def __init__(self, id, access_hash=None):
        self.id = id
        self.access_hash = access_hash


class CleanMediaIdsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = _load_service()

    def test_parses_decimal_strings_positive_int64(self):
        svc = self.svc
        self.assertEqual(svc._clean_media_ids(["1", "2", "9223372036854775807"]),
                         [1, 2, 9223372036854775807])

    def test_dedupes_preserving_first_seen_order(self):
        self.assertEqual(self.svc._clean_media_ids(["5", "5", "6", "5"]), [5, 6])

    def test_rejects_nonpositive_out_of_range_and_garbage(self):
        svc = self.svc
        self.assertEqual(svc._clean_media_ids([
            "0", "-3", "+3", "03", "1.0", "9223372036854775808", "x", None, "", "  "
        ]), [])

    def test_caps_the_count(self):
        svc = self.svc
        many = [str(i) for i in range(1, svc._MEDIA_REPAIR_IDS_MAX * 3)]
        out = svc._clean_media_ids(many)
        self.assertEqual(len(out), svc._MEDIA_REPAIR_IDS_MAX)
        self.assertEqual(out, list(range(1, svc._MEDIA_REPAIR_IDS_MAX + 1)))

    def test_non_list_input_is_empty(self):
        svc = self.svc
        self.assertEqual(svc._clean_media_ids("123"), [])
        self.assertEqual(svc._clean_media_ids(None), [])
        self.assertEqual(svc._clean_media_ids({"1": 1}), [])


class DownloadThumbFallbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = _load_service()

    def test_non_jpeg_first_candidate_falls_through_to_next_jpeg(self):
        jpeg = b'\xff\xd8\x01\x02'
        client = _IndexedThumbClient({(7, 1): b'RIFF-webp', (7, 0): jpeg})
        out = run(self.svc._download_thumb_bytes(
            client, _MediaMessage(7, photo=True), 'sm', accept=self.svc._is_persistable_jpeg_cover))
        self.assertEqual(out, jpeg)
        self.assertEqual(client.calls, [(7, 1), (7, 0)])

    def test_oversized_first_candidate_falls_through_to_bounded_jpeg(self):
        svc = self.svc
        jpeg = b'\xff\xd8\x03\x04'
        oversized = b'\xff\xd8' + b'x' * svc._THUMB_MAX_BYTES
        client = _IndexedThumbClient({(8, 1): oversized, (8, 0): jpeg})
        out = run(svc._download_thumb_bytes(
            client, _MediaMessage(8, video=True), 'sm', accept=svc._is_persistable_jpeg_cover))
        self.assertEqual(out, jpeg)
        self.assertEqual(client.calls, [(8, 1), (8, 0)])

    def test_invalid_small_candidates_fall_through_to_larger_bounded_thumbnail(self):
        svc = self.svc
        jpeg = b'\xff\xd8\x05\x06'
        client = _IndexedThumbClient({(81, 1): b'RIFF-webp', (81, 0): None, (81, 2): jpeg})
        out = run(svc._download_thumb_bytes(
            client, _MediaMessage(81, video=True), 'sm', accept=svc._is_persistable_jpeg_cover))
        self.assertEqual(out, jpeg)
        self.assertEqual(client.calls, [(81, 1), (81, 0), (81, 2)])

    def test_all_invalid_candidates_return_none(self):
        svc = self.svc
        client = _IndexedThumbClient({
            (9, 1): b'not-jpeg', (9, 0): b'also-bad', (9, 2): None, (9, -1): b'bad-largest',
        })
        out = run(svc._download_thumb_bytes(
            client, _MediaMessage(9, photo=True), 'sm', accept=svc._is_persistable_jpeg_cover))
        self.assertIsNone(out)
        self.assertEqual(client.calls, [(9, 1), (9, 0), (9, 2), (9, -1)])

    def test_floodwait_still_propagates_without_trying_another_index(self):
        svc = self.svc
        client = _IndexedThumbClient({(10, 1): FloodWaitError(seconds=30), (10, 0): b'\xff\xd8\x01\x02'})
        with self.assertRaises(FloodWaitError):
            run(svc._download_thumb_bytes(
                client, _MediaMessage(10, video=True), 'sm', accept=svc._is_persistable_jpeg_cover))
        self.assertEqual(client.calls, [(10, 1)])


class CollectMediaByIdTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = _load_service()

    def test_mixed_photo_video_and_no_thumb_returns_only_real_covers(self):
        svc = self.svc
        jpeg_p = b'\xff\xd8\xaa\xbb'
        jpeg_v = b'\xff\xd8\xcc\xdd'
        client = _ThumbClient({10: jpeg_p, 20: jpeg_v, 30: None})
        messages = [
            _MediaMessage(10, photo=True),
            _MediaMessage(20, video=True),
            _MediaMessage(30, photo=True),   # media but no downloadable thumb → skipped
            _MediaMessage(40),               # not photo/video → skipped, never downloaded
            None,                            # missing message id → skipped
        ]
        out = run(svc._collect_media_by_id(client, messages, budget_s=5))
        self.assertEqual(out, [
            {'post_id': '10', 'size': 'sm', 'jpeg_b64': base64.b64encode(jpeg_p).decode('ascii')},
            {'post_id': '20', 'size': 'sm', 'jpeg_b64': base64.b64encode(jpeg_v).decode('ascii')},
        ])
        self.assertNotIn(40, [c[0] for c in client.calls], 'non-media id is never downloaded')

    def test_album_candidate_fallback_produces_a_persistable_cover(self):
        svc = self.svc
        jpeg = b'\xff\xd8\xaa\xbb'
        client = _IndexedThumbClient({(1312, 1): b'RIFF-webp', (1312, 0): jpeg})
        out = run(svc._collect_media_by_id(client, [_MediaMessage(1312, video=True)], budget_s=5))
        self.assertEqual(out, [{
            'post_id': '1312', 'size': 'sm', 'jpeg_b64': base64.b64encode(jpeg).decode('ascii'),
        }])
        self.assertEqual(client.calls, [(1312, 1), (1312, 0)])

    def test_post_id_is_a_decimal_string_for_bigint_safety(self):
        svc = self.svc
        big = 9_007_199_254_740_997   # > 2**53 → must survive as an exact string, never a JS Number
        client = _ThumbClient({big: b'\xff\xd8\x01\x02'})
        out = run(svc._collect_media_by_id(client, [_MediaMessage(big, photo=True)], budget_s=5))
        self.assertEqual(out[0]['post_id'], str(big))

    def test_rejects_non_jpeg_and_oversized(self):
        svc = self.svc
        client = _ThumbClient({1: b'not-jpeg', 2: b'\xff\xd8' + b'x' * svc._THUMB_MAX_BYTES})
        out = run(svc._collect_media_by_id(
            client, [_MediaMessage(1, photo=True), _MediaMessage(2, photo=True)], budget_s=5))
        self.assertEqual(out, [])

    def test_total_byte_cap_stops_growth(self):
        svc = self.svc
        old = svc._THUMBS_TOTAL_BYTES_MAX
        svc._THUMBS_TOTAL_BYTES_MAX = 6
        try:
            client = _ThumbClient({1: b'\xff\xd8\x01\x02', 2: b'\xff\xd8\x03\x04'})
            out = run(svc._collect_media_by_id(
                client, [_MediaMessage(1, photo=True), _MediaMessage(2, photo=True)], budget_s=5))
            self.assertEqual([r['post_id'] for r in out], ['1'])
        finally:
            svc._THUMBS_TOTAL_BYTES_MAX = old

    def test_per_download_timeout_isolates_without_raising(self):
        svc = self.svc
        old = svc._THUMB_DOWNLOAD_TIMEOUT_S
        svc._THUMB_DOWNLOAD_TIMEOUT_S = 0.01
        try:
            class _OneSlowClient:
                async def download_media(self, msg, thumb=None, file=None):
                    if msg.id == 1:
                        await asyncio.sleep(0.05)
                    return b'\xff\xd8\x01\x02'

            out = run(svc._collect_media_by_id(
                _OneSlowClient(),
                [_MediaMessage(1, photo=True), _MediaMessage(2, photo=True)],
                budget_s=5,
            ))
            self.assertEqual([row['post_id'] for row in out], ['2'], 'one slow id does not block the next')
        finally:
            svc._THUMB_DOWNLOAD_TIMEOUT_S = old

    def test_floodwait_stops_the_phase_but_never_raises(self):
        svc = self.svc

        class _FloodClient:
            def __init__(self):
                self.calls = 0

            async def download_media(self, msg, thumb=None, file=None):
                self.calls += 1
                raise FloodWaitError(seconds=30)

        client = _FloodClient()
        out = run(svc._collect_media_by_id(
            client, [_MediaMessage(1, photo=True), _MediaMessage(2, photo=True)], budget_s=5))
        self.assertEqual(out, [])
        self.assertEqual(client.calls, 1, 'FloodWait stops the phase immediately, other ids not hammered')

    def test_zero_budget_downloads_nothing(self):
        svc = self.svc
        client = _ThumbClient({1: b'\xff\xd8\x01\x02'})
        out = run(svc._collect_media_by_id(client, [_MediaMessage(1, photo=True)], budget_s=0))
        self.assertEqual(out, [])
        self.assertEqual(client.calls, [])


class _EndpointClient:
    """Ephemeral-client duck type for the qr_media endpoint body."""

    instances = []

    def __init__(self, *a, **k):
        self.authorized = True
        self.messages = []
        self.connected = True
        self.disconnected = False
        _EndpointClient.instances.append(self)

    async def connect(self):
        return None

    async def is_user_authorized(self):
        return self.authorized

    async def get_messages(self, entity, ids=None):
        return self.messages

    def is_connected(self):
        return self.connected

    async def disconnect(self):
        self.disconnected = True
        self.connected = False


class QrMediaEndpointTests(unittest.TestCase):
    def setUp(self):
        self.svc = _load_service()
        self.svc.API_ID = 123
        self.svc.API_HASH = 'hash'
        self.svc.MTPROTO_TOKEN = 'tok'
        self.svc.StringSession = lambda s='': s
        _EndpointClient.instances = []
        self.svc.TelegramClient = _EndpointClient
        self._entity = _Entity(-1001234567890, 55)

        async def fake_resolve(tg, ref, access_hash=None):
            return self._entity
        self.svc._resolve_channel_entity = fake_resolve

    def _call(self, **kw):
        kw.setdefault('session', 'plain-session')
        kw.setdefault('channel', '-1001234567890')
        kw.setdefault('msg_ids', ['10', '20'])
        kw.setdefault('x_internal_token', 'tok')
        return run(self.svc.qr_media(**kw))

    def test_bad_token_is_unauthorized(self):
        with self.assertRaises(_StubHTTPException) as cm:
            self._call(x_internal_token='wrong')
        self.assertEqual(cm.exception.status_code, 401)

    def test_not_configured_when_api_creds_absent(self):
        self.svc.API_ID = 0
        with self.assertRaises(_StubHTTPException) as cm:
            self._call()
        self.assertEqual(cm.exception.detail, 'mtproto_not_configured')

    def test_blank_session_is_rejected(self):
        with self.assertRaises(_StubHTTPException) as cm:
            self._call(session='   ')
        self.assertEqual(cm.exception.detail, 'session_required')

    def test_empty_or_all_garbage_msg_ids_rejected(self):
        for ids in ([], ['0', 'x', '-1']):
            with self.assertRaises(_StubHTTPException) as cm:
                self._call(msg_ids=ids)
            self.assertEqual(cm.exception.detail, 'msg_ids_required')

    def test_unauthorized_session_returns_401(self):
        def factory(*a, **k):
            c = _EndpointClient()
            c.authorized = False
            return c
        self.svc.TelegramClient = factory
        with self.assertRaises(_StubHTTPException) as cm:
            self._call()
        self.assertEqual(cm.exception.detail, 'session_unauthorized')

    def test_success_returns_only_real_covers_plus_entity_identity(self):
        jpeg = b'\xff\xd8\x01\x02'

        class _MsgClient(_EndpointClient):
            def __init__(self, *a, **k):
                super().__init__(*a, **k)
                self.messages = [
                    _MediaMessage(10, photo=True),
                    _MediaMessage(20, video=True),
                    None,
                ]

            async def download_media(self, msg, thumb=None, file=None):
                return jpeg if msg.id == 10 else None

        self.svc.TelegramClient = _MsgClient
        out = self._call()
        self.assertEqual(out['covers'], [
            {'post_id': '10', 'size': 'sm', 'jpeg_b64': base64.b64encode(jpeg).decode('ascii')},
        ])
        # Resolved identity (int64 as exact strings) for the web side to bind to the requested channel.
        self.assertEqual(out['entity'], {'id': '-1001234567890', 'access_hash': '55'})

    def test_cleanup_disconnects_client_and_releases_semaphore(self):
        before = self.svc._QR_COLLECT_SEM._value
        self._call()
        self.assertEqual(self.svc._QR_COLLECT_SEM._value, before, 'the collect permit is always returned')
        self.assertTrue(_EndpointClient.instances[-1].disconnected, 'ephemeral client is disconnected')


if __name__ == "__main__":
    unittest.main()
