# Pulse Analytics

Дашборд аналитики Telegram-канала (+ задел под Instagram). Данные по Telegram
тянутся **через твой личный профиль по MTProto** (Telethon) — это даёт куда
больше, чем Bot API: просмотры, репосты, реакции, комментарии и статистику
канала (рост подписчиков, источники просмотров/подписчиков, активность по часам,
языки аудитории, тональность реакций и т.д.).

## Архитектура

**Прод (Railway): два независимых сервиса**, связанные приватной сетью —
веб может рестартовать/скейлиться/деплоиться отдельно от тяжёлого MTProto-клиента,
а падение Python не утаскивает дашборд и не мешает логам.

```
pulse-analytics/
├── server/index.js     ← Node/Express: дашборд + API на публичном $PORT,
│                          проксирует /api/tg/mtproto/* в MTProto-сервис
├── public/index.html   ← фронтенд (vanilla JS, inline-SVG графики, без CDN)
├── mtproto/
│   ├── service.py       ← Python/FastAPI + Telethon (MTProto), слушает :8001
│   └── requirements.txt
├── Dockerfile.web       ← образ WEB-сервиса (только Node)        ← публичный
├── Dockerfile.mtproto   ← образ MTProto-сервиса (только Python)  ← приватный
├── Dockerfile           ← LEGACY: оба процесса в одном образе (локалка/миграция)
└── package.json
```

```
[браузер] ──► WEB (Node, $PORT, публичный домен)
                   │  MTPROTO_URL=http://mtproto.railway.internal:8001
                   ▼
              MTPROTO (Python/Telethon, :8001, приватный, без домена) ──► Telegram
```

Web ходит к Python по `MTPROTO_URL`; аутентификация межсервисная — заголовок
`x-internal-token: TEAM_PASSWORD` (общий секрет на обоих сервисах).

Для **локальной разработки** удобнее legacy-режим (оба процесса разом) — см.
«Запуск локально». Корневой `Dockerfile` оставлен ради него и zero-downtime
миграции; после катовера его можно удалить.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `TEAM_PASSWORD` | пароль для входа команды (он же секрет подписи stateless-токенов) |
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
npm start                        # сайт на http://localhost:3000
```

## Деплой на Railway — два сервиса (рекомендуется)

Оба сервиса деплоятся из ЭТОГО же репозитория, отличаются только Dockerfile'ом
(Settings → Build → **Dockerfile Path**, либо переменная `RAILWAY_DOCKERFILE_PATH`).
`TEAM_PASSWORD` и `TG_CHANNEL` должны совпадать на обоих.

**1. MTProto-сервис (приватный) — создать первым:**
- New Service → Deploy from GitHub → этот репозиторий.
- **Dockerfile Path:** `Dockerfile.mtproto`.
- **Variables:** `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`, `TG_CHANNEL`,
  `TEAM_PASSWORD`, `MTPROTO_PORT=8001` (+ опц. `MENTION_QUERIES`, `MENTION_EXCLUDE`).
- **Networking:** публичный домен НЕ создавать (сервис только во внутренней сети).
- Деплой → проверить по логам, что Telethon подключился.

**2. WEB-сервис (публичный):**
- Либо переиспользовать текущий сервис, либо создать новый из репозитория.
- **Dockerfile Path:** `Dockerfile.web`.
- **Variables:** `TEAM_PASSWORD` (тот же!), `TG_CHANNEL` (тот же), `PORT=8080`,
  `DATABASE_URL`, `INGEST_TOKEN`, `SESSION_SECRET`, `ADMIN_EMAIL`/`ADMIN_PASSWORD`,
  `GITHUB_REPO`/`GITHUB_DISPATCH_TOKEN`, опц. `TG_BOT_TOKEN`, `IG_*`, и главное —
  **`MTPROTO_URL=http://<имя-mtproto-сервиса>.railway.internal:8001`**.
- **Networking:** публичный домен → target port **8080**.

**Порядок катовера (zero-downtime):** mtproto подняли и проверили → затем
переключили web на `Dockerfile.web` + добавили `MTPROTO_URL` → проверили дашборд →
старый одно-контейнерный сервис вывели из-под домена и удалили.

**Откат:** вернуть web на корневой `Dockerfile` (legacy, оба процесса в одном
образе) и убрать `MTPROTO_URL` — сайт снова самодостаточен.

> Ingest-крон (`.github/workflows/ingest.yml`) бьёт в публичный web
> `/api/ingest/daily`, поэтому при сплите его менять не нужно — web сам ходит в
> mtproto по приватной сети.

### Legacy: один сервис (один контейнер)

Корневой `Dockerfile` собирает оба процесса в один образ
(`python3 mtproto/service.py & exec node server/index.js`). Для него: Root
Directory пусто, `MTPROTO_URL` не задавать (дефолт `http://localhost:8001`),
`PORT=8080`, домен на 8080. Подходит для быстрого старта и локалки.

## ⚠️ Важно: версия Telethon

`telethon` должен быть **>= 1.43.2**. Старые версии (напр. 1.36.0) не парсят
текущий TL-layer Telegram и падают на `get_entity`/`get_messages` с
*"Could not find a matching Constructor ID"* — канал и посты приходят пустыми
(хотя статистика-графики при этом работают). Если посты/просмотры внезапно `0` —
проверь версию Telethon первым делом.

## API

| Метод | URL | Описание |
|---|---|---|
| `POST` | `/api/auth/login` | вход (пароль → stateless-токен на 8 ч) |
| `GET` | `/api/auth/check` | проверка сессии |
| `GET` | `/api/tg/channel` | инфо о канале (bot API → фолбэк на MTProto) |
| `GET` | `/api/tg/full?limit=N` | агрегат: канал + views_summary + посты |
| `GET` | `/api/tg/mtproto/stats` | GetBroadcastStats (скаляры) |
| `GET` | `/api/tg/mtproto/graphs` | нормализованные графики статистики |
| `GET` | `/api/tg/mtproto/thumb/:id` | превью медиа поста (image/jpeg) |
| `GET` | `/api/health` | статус |

## Безопасность

- Токены/сессия — только в переменных окружения, не в коде.
- Авторизация: stateless HMAC-токен (подписан `TEAM_PASSWORD`), переживает рестарт.
- Rate limiting на `/api/`, кэш ответов ~10 минут.
- `/api/tg/mtproto/thumb/:id` — открытый роут (img-теги не шлют заголовки), отдаёт
  только превью постов настроенного (публичного) канала.
