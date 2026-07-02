# Atlavue

Дашборд аналитики Telegram-канала (+ задел под Instagram). Данные по Telegram
тянутся **через твой личный профиль по MTProto** (Telethon) — это даёт куда
больше, чем Bot API: просмотры, репосты, реакции, комментарии и статистику
канала (рост подписчиков, источники просмотров/подписчиков, активность по часам,
языки аудитории, тональность реакций и т.д.).

## Архитектура

**Прод (Railway): два независимых сервиса**, связанные приватной сетью, плюс
локальный collector для пользовательских каналов:
веб может рестартовать/скейлиться/деплоиться отдельно от тяжёлого MTProto-клиента,
а падение Python не утаскивает дашборд и не мешает логам.

```
pulse-analytics/
├── server/index.js     ← Node/Express: дашборд + API на публичном $PORT,
│                          проксирует /api/tg/mtproto/* в MTProto-сервис
├── server/migrations/  ← версионированные SQL-миграции
├── public/             ← vanilla JS + inline-SVG графики
├── mtproto/
│   ├── service.py       ← Python/FastAPI + Telethon (MTProto), слушает :8001
│   └── requirements.txt
├── collector/
│   └── pulse_collector.py ← локальный агент: queue/retry/doctor
├── Dockerfile.web       ← образ WEB-сервиса (только Node)        ← публичный
├── Dockerfile.mtproto   ← образ MTProto-сервиса (только Python)  ← приватный
├── Dockerfile.collector ← опциональный локальный образ collector
└── package.json
```

```
[браузер] ──► WEB (Node, $PORT, публичный домен)
                   │  MTPROTO_URL=http://mtproto.railway.internal:8001
                   ▼
              MTPROTO (Python/Telethon, :8001, приватный, без домена) ──► Telegram

[collector пользователя] ──► POST /api/collector/ingest ──► Postgres
       │
       └── TG_SESSION остаётся локально и никогда не отправляется в SaaS
```

Web ходит к Python по `MTPROTO_URL`; аутентификация межсервисная — заголовок
`x-internal-token: MTPROTO_TOKEN` (одинаковое значение на обоих сервисах;
без него MTProto-сервис отвечает 503 — fail-closed).

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `SESSION_SECRET` | секрет подписи web-сессий (напр. `openssl rand -hex 32`); **обязателен в проде** — без него web не стартует |
| `MTPROTO_TOKEN` | межсервисный секрет web ↔ mtproto; задать **одинаковым** на обоих сервисах |
| `DATABASE_URL` | Postgres; `npm start` применяет SQL-миграции перед запуском web |
| `COLLECTOR_STALE_HOURS` | через сколько часов без ingest показать предупреждение (по умолчанию `24`) |
| `TG_API_ID` / `TG_API_HASH` | приложение Telegram с my.telegram.org (та же пара, которой создавалась сессия) |
| `TG_SESSION` | **StringSession** твоего аккаунта (см. ниже) |
| `TG_CHANNEL` | канал, напр. `@bynotem` |
| `MTPROTO_PORT` | порт, который слушает Python-сервис (по умолчанию `8001`) |
| `MTPROTO_URL` | **(web)** адрес MTProto-сервиса; при сплите — `http://<mtproto>.railway.internal:8001`; локально/legacy — `http://localhost:8001` |
| `PORT` | порт Node (на Railway выставить `8080` и навести домен на него) |
| `TG_BOT_TOKEN` | *опционально* — Bot API как резерв; MTProto работает и без него |
| `IG_ACCESS_TOKEN` / `IG_ACCOUNT_ID` | *опционально* — Instagram (пока не используется) |

### Как получить `TG_SESSION` (один раз, локально)

```python
from telethon.sync import TelegramClient
from telethon.sessions import StringSession
api_id, api_hash = 12345, "xxxx"
with TelegramClient(StringSession(), api_id, api_hash) as c:
    print(c.session.save())   # вставь результат в TG_SESSION
```

Введёшь телефон и код из Telegram. Строка = полный доступ к аккаунту, **храни в
секрете, не коммить**.

## Запуск локально

```bash
npm install
pip install -r mtproto/requirements.txt
# выставь переменные окружения (например через .env + dotenv)
python3 mtproto/service.py &     # MTProto на :8001
npm start                        # миграции, затем сайт на http://localhost:3000
```

## Пользовательский collector

Collector запускается на машине пользователя, использует его `TG_SESSION`
локально и отправляет только готовые метрики. Создай канал и API-ключ в кабинете,
затем выставь:

```env
PULSE_API_URL=https://pulse-analytics-production-daf3.up.railway.app
PULSE_API_KEY=pa_...
TG_API_ID=123456
TG_API_HASH=...
TG_SESSION=...
TG_CHANNEL=@your_channel
```

Проверка и запуск:

```bash
python collector/pulse_collector.py doctor
python collector/pulse_collector.py once
python collector/pulse_collector.py run
```

Неотправленные payload сохраняются в локальной SQLite-очереди и повторяются с
exponential backoff. Повтор безопасен: сервер дедуплицирует запросы по
`(channel_id, ingest_id)`. Docker-вариант:

```bash
docker build -f Dockerfile.collector -t pulse-collector .
docker run --env-file .env -v pulse-collector-data:/data pulse-collector doctor
docker run -d --restart unless-stopped --env-file .env \
  -v pulse-collector-data:/data pulse-collector run
```

## Деплой на Railway — два сервиса (рекомендуется)

Оба сервиса деплоятся из ЭТОГО же репозитория, отличаются только Dockerfile'ом
(Settings → Build → **Dockerfile Path**, либо переменная `RAILWAY_DOCKERFILE_PATH`).
`MTPROTO_TOKEN` и `TG_CHANNEL` должны совпадать на обоих.

**1. MTProto-сервис (приватный) — создать первым:**
- New Service → Deploy from GitHub → этот репозиторий.
- **Dockerfile Path:** `Dockerfile.mtproto`.
- **Variables:** `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`, `TG_CHANNEL`,
  `MTPROTO_TOKEN`, `MTPROTO_PORT=8001` (+ опц. `MENTION_QUERIES`, `MENTION_EXCLUDE`).
- **Networking:** публичный домен НЕ создавать (сервис только во внутренней сети).
- Деплой → проверить по логам, что Telethon подключился.

**2. WEB-сервис (публичный):**
- Либо переиспользовать текущий сервис, либо создать новый из репозитория.
- **Dockerfile Path:** `Dockerfile.web`.
- **Variables:** `SESSION_SECRET` (обязателен), `MTPROTO_TOKEN` (тот же, что на
  mtproto!), `TG_CHANNEL` (тот же), `PORT=8080`, `DATABASE_URL`, `INGEST_TOKEN`,
  `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `GITHUB_REPO`/`GITHUB_DISPATCH_TOKEN`,
  опц. `TG_BOT_TOKEN`, `IG_*`, и главное —
  **`MTPROTO_URL=http://<имя-mtproto-сервиса>.railway.internal:8001`**.
- **Networking:** публичный домен → target port **8080**.

> Ingest-крон (`.github/workflows/ingest.yml`) бьёт в публичный web
> `/api/ingest/daily`, поэтому при сплите его менять не нужно — web сам ходит в
> mtproto по приватной сети.

## ⚠️ Важно: версия Telethon

`telethon` должен быть **>= 1.43.2**. Старые версии (напр. 1.36.0) не парсят
текущий TL-layer Telegram и падают на `get_entity`/`get_messages` с
*"Could not find a matching Constructor ID"* — канал и посты приходят пустыми
(хотя статистика-графики при этом работают). Если посты/просмотры внезапно `0` —
проверь версию Telethon первым делом.

## API

| Метод | URL | Описание |
|---|---|---|
| `POST` | `/api/auth/login` | вход (подписанная сессия на 8 ч с server-side отзывом) |
| `GET` | `/api/auth/check` | проверка сессии |
| `GET` | `/api/collector/compatibility` | версия ingest-контракта и лимиты |
| `POST` | `/api/collector/ingest` | транзакционный, идемпотентный приём collector payload |
| `GET` | `/api/channels/:id/collector-status` | последний успешный ingest/ошибка |
| `GET` | `/api/tg/channel` | инфо о канале (bot API → фолбэк на MTProto) |
| `GET` | `/api/tg/full?limit=N` | агрегат: канал + views_summary + посты |
| `GET` | `/api/tg/mtproto/stats` | GetBroadcastStats (скаляры) |
| `GET` | `/api/tg/mtproto/graphs` | нормализованные графики статистики |
| `GET` | `/api/tg/mtproto/thumb/:id` | превью медиа поста (image/jpeg) |
| `GET` | `/api/health` | liveness web-процесса |
| `GET` | `/api/ready` | readiness с проверкой Postgres |

## Безопасность

- Токены/сессия — только в переменных окружения, не в коде.
- Авторизация: HMAC-токен, подписанный `SESSION_SECRET`; `token_version` позволяет
  отозвать все сессии при logout, смене пароля, роли или статуса.
- API-ключи collector хранятся только как SHA-256; сырой ключ показывается один раз.
- Collector payload проходит строгую нормализацию чисел/строк и версионируется.
- Ingest пишет receipt, snapshot и архивы одной транзакцией.
- Security-события пишутся в `audit_events` без секретов и сырых IP.
- Rate limiting на `/api/`, кэш ответов ~10 минут.
- `/api/tg/mtproto/thumb/:id` — открытый роут (img-теги не шлют заголовки), отдаёт
  только превью постов настроенного (публичного) канала.
