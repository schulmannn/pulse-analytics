"""Тексты исключений Telethon не выходят из QR-входа наружу (L-4, аудит #554).

`_qr_watch` и `qr_password` складывали `str(e)` в `entry['error']` и в тело ответа, а web-роут
`/api/tg/qr/{poll,password}` пересказывал это поле браузеру, где фронт печатает его дословно.
Пользователю сообщение драйвера не говорит ничего; постороннему оно рассказывает про версию
Telethon, имена TL-запросов и внутренности приватного сервиса. Наружу должен уходить код, а само
исключение — оставаться в логе сервиса.

telethon / fastapi / uvicorn / dotenv заглушаются через sys.modules до импорта модуля по пути —
тот же приём, что в test_qr_media.py (канон CLAUDE.md).
"""
import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path


class _StubHTTPException(Exception):
    def __init__(self, status_code=None, detail=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class _Passthrough:
    def __call__(self, *a, **k):
        if len(a) == 1 and callable(a[0]) and not k:
            return a[0]
        return self

    def __getattr__(self, _):
        return self


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
    for name in ("FloodWaitError", "UnauthorizedError", "ChannelInvalidError",
                 "PasswordHashInvalidError", "SessionPasswordNeededError"):
        setattr(errors, name, type(name, (Exception,), {}))
    telethon.errors = errors
    sessions = mod("telethon.sessions")
    sessions.StringSession = object
    telethon.sessions = sessions
    tl = mod("telethon.tl")
    telethon.tl = tl
    functions = mod("telethon.tl.functions")
    tl.functions = functions
    stats = mod("telethon.tl.functions.stats")
    for name in ("GetBroadcastStatsRequest", "LoadAsyncGraphRequest", "GetMessageStatsRequest"):
        setattr(stats, name, object)
    functions.stats = stats
    channels = mod("telethon.tl.functions.channels")
    for name in ("GetFullChannelRequest", "SearchPostsRequest", "CheckSearchPostsFloodRequest",
                 "GetAdminedPublicChannelsRequest"):
        setattr(channels, name, object)
    functions.channels = channels
    tltypes = mod("telethon.tl.types")
    for name in ("StatsGraph", "StatsGraphAsync", "InputPeerEmpty", "InputPeerChannel", "PeerChannel"):
        setattr(tltypes, name, type(name, (), {}))
    tl.types = tltypes

    mod("dotenv").load_dotenv = lambda *a, **k: None


def _load_service():
    _install_stubs()
    path = Path(__file__).resolve().parents[1] / "mtproto" / "service.py"
    spec = importlib.util.spec_from_file_location("mtproto_service_qr_errors_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(coro):
    return asyncio.run(coro)


# Реальный вид сообщения Telethon: версия, имя TL-запроса и путь в исходниках драйвера.
LEAK = ("Server sent a very special error: [500] AUTH_KEY_UNREGISTERED "
        "(caused by ImportLoginTokenRequest at telethon/client/auth.py:412)")


class _Client:
    """Дак-тайп ephemeral-клиента: ровно то, что трогают _qr_finish и _safe_disconnect."""

    def __init__(self, me_raises=None):
        self.me_raises = me_raises
        self.disconnected = False
        self.session = types.SimpleNamespace(save=lambda: "session-string")

    def is_connected(self):
        return not self.disconnected

    async def disconnect(self):
        self.disconnected = True

    async def get_me(self):
        if self.me_raises:
            raise self.me_raises
        return types.SimpleNamespace(id=42, username="owner")

    async def sign_in(self, password=None):
        return None


class _Qr:
    """qr_login-объект: wait() либо падает, либо пропускает управление в _qr_finish."""

    def __init__(self, wait_raises=None):
        self.wait_raises = wait_raises

    async def wait(self, timeout=None):
        if self.wait_raises:
            raise self.wait_raises
        return True

    async def recreate(self):
        return True


class QrErrorTextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = _load_service()
        # check_auth fail-closed при пустом токене: в тестовом окружении env нет, поэтому
        # внутренний токен задаётся здесь — иначе роут отвечал бы 503 до самой проверки.
        cls.svc.MTPROTO_TOKEN = "test-internal-token"

    def setUp(self):
        self.svc._QR.clear()

    def tearDown(self):
        self.svc._QR.clear()

    def _entry(self, wait_raises=None, me_raises=None):
        client = _Client(me_raises=me_raises)
        entry = {"client": client, "qr": _Qr(wait_raises), "url": "tg://login",
                 "status": "pending", "created": self.svc.time.time()}
        self.svc._QR["login-1"] = entry
        return entry, client

    def test_watch_failure_reports_a_code_and_logs_the_exception(self):
        entry, client = self._entry(wait_raises=RuntimeError(LEAK))
        with self.assertLogs(self.svc.log, level="WARNING") as captured:
            run(self.svc._qr_watch("login-1"))

        self.assertEqual(entry["status"], "error")
        self.assertEqual(entry["error"], "login_failed")
        self.assertTrue(client.disconnected, "эфемерный клиент всё равно закрывается")
        # Исходное исключение не потеряно — оно осталось в логе сервиса.
        self.assertTrue(any(LEAK in line for line in captured.output))

    def test_finish_failure_after_a_scan_reports_a_code(self):
        entry, _client = self._entry(me_raises=RuntimeError(LEAK))
        with self.assertLogs(self.svc.log, level="WARNING") as captured:
            run(self.svc._qr_watch("login-1"))

        self.assertEqual(entry["status"], "error")
        self.assertEqual(entry["error"], "finish_failed")
        self.assertTrue(any(LEAK in line for line in captured.output))

    def test_poll_hands_the_web_only_the_code(self):
        self._entry(wait_raises=RuntimeError(LEAK))
        with self.assertLogs(self.svc.log, level="WARNING"):
            run(self.svc._qr_watch("login-1"))
        out = run(self.svc.qr_poll(id="login-1", x_internal_token=self.svc.MTPROTO_TOKEN))

        self.assertEqual(out, {"status": "error", "error": "login_failed"})
        self.assertNotIn("telethon", str(out))
        self.assertNotIn("AUTH_KEY_UNREGISTERED", str(out))

    def test_password_finish_failure_reports_a_code(self):
        entry, _client = self._entry(me_raises=RuntimeError(LEAK))
        entry["status"] = "password"
        with self.assertLogs(self.svc.log, level="WARNING") as captured:
            out = run(self.svc.qr_password(id="login-1", password="hunter2",
                                           x_internal_token=self.svc.MTPROTO_TOKEN))

        self.assertEqual(out, {"status": "error", "error": "finish_failed"})
        self.assertNotIn("telethon", str(out))
        self.assertTrue(any(LEAK in line for line in captured.output))


if __name__ == "__main__":
    unittest.main()
