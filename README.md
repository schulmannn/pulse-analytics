# Atlavue

Atlavue — дашборд аналитики Telegram и Instagram для авторов и команд: метрики аккаунтов и
публикаций, кампании из нескольких источников, отчёты и настраиваемая Главная.

Текущее состояние, принятые решения и ближайшая очередь поддерживаются в
[`PROJECT_MEMORY.md`](PROJECT_MEMORY.md). Правила для worker-агентов находятся в
[`CLAUDE.md`](CLAUDE.md).

## Архитектура

```text
frontend/            React 18 + Vite + TypeScript strict, TanStack Query, Zod, Tailwind
server/              Node.js/Express: config -> app -> composition -> main
server/migrations/   forward-only SQL-миграции, применяются перед запуском web
mtproto/service.py   приватный FastAPI/Telethon-сервис
collector/           альтернативный локальный Telegram collector
```

Production состоит из публичного web-сервиса, Postgres и приватного MTProto-сервиса. Web отдаёт
SPA и API, а к Python обращается по внутренней сети через `MTPROTO_URL` с заголовком на общем
`MTPROTO_TOKEN`.

Telegram поддерживает две модели подключения:

- **управляемая** — пользователь входит по QR, сессия шифруется `TG_SESSION_KEY` и хранится в
  Postgres; приватный MTProto-сервис собирает данные;
- **локальная** — `collector/pulse_collector.py` хранит сессию на машине пользователя и отправляет
  только производные метрики через `/api/collector/ingest`.

Подробнее о состоянии системы и её инвариантах — в [`PROJECT_MEMORY.md`](PROJECT_MEMORY.md).

## Основные переменные окружения

Полный канонический список и production-валидация находятся в [`server/config.js`](server/config.js).

| Переменная | Где | Назначение |
|---|---|---|
| `APP_URL` | web | публичный HTTPS-origin, в production — `https://atlavue.app` |
| `SESSION_SECRET` | web | подпись пользовательских сессий; обязательна в production |
| `DATABASE_URL` | web | Postgres; в production обязательна, кроме явного `ALLOW_DBLESS=true` |
| `PGPOOL_MAX` | web | размер основного пула Postgres (live HTTP/auth/tenant), по умолчанию `10` (одна web-реплика, ADR-002) |
| `PGPOOL_BACKGROUND_MAX` | web | размер отдельного малого пула для фонового сбора/отчётов/maintenance, по умолчанию `2` (те же fail-fast deadlines) |
| `PG_CONNECTION_TIMEOUT_MS` | web | fail-fast на выдачу коннекта из пула, мс, по умолчанию `3000` |
| `PG_STATEMENT_TIMEOUT_MS` | web | серверный `statement_timeout`, мс, по умолчанию `30000` |
| `PG_QUERY_TIMEOUT_MS` | web | клиентский `query_timeout` (чуть выше statement), мс, по умолчанию `35000` |
| `MTPROTO_URL` | web | внутренний URL Python-сервиса, обычно `http://<service>.railway.internal:8001` |
| `MTPROTO_TOKEN` | web + mtproto | общий межсервисный секрет; без него доступ fail-closed |
| `TG_SESSION_KEY` | web | ключ AES-256-GCM для управляемых QR-сессий |
| `TG_API_ID`, `TG_API_HASH` | mtproto/collector | Telegram application credentials |
| `TG_SESSION`, `TG_CHANNEL` | mtproto | служебная управляемая Telegram-сессия и канал, если используются |
| `IG_CLIENT_ID`, `IG_CLIENT_SECRET`, `IG_TOKEN_KEY` | web | Instagram Login и шифрование account token |
| `INGEST_TOKEN` | web/cron | авторизация daily ingest через `x-ingest-token` |
| `COLLECTOR_STALE_HOURS` | web | порог устаревания collector, по умолчанию 24 часа |
| `IG_ACCOUNTS_PER_PASS` | web | сколько НОВОСТАРТОВАННЫХ IG-аккаунтов сбор трогает за один проход (durable per-account/day), по умолчанию `25`; завершённые за день пропускаются и лимит не тратят |
| `TG_QR_CHANNELS_PER_PASS` | web | сколько НОВОСТАРТОВАННЫХ QR-каналов TG-сбор трогает за один проход, по умолчанию `200` |
| `COLLECTION_RECOVERY_INITIAL_DELAY_MS` | web | задержка первого прохода recovery-бегунка после старта, мс, по умолчанию `30000`, минимум `1000` |
| `COLLECTION_RECOVERY_INTERVAL_MS` | web | период повторных проходов recovery-бегунка, мс, по умолчанию `900000` (15 мин), минимум `60000` |

Секреты не добавляются в `.env`-файлы репозитория, логи, issue или PR.

## Локальный запуск

Установить зависимости:

```bash
npm ci
npm ci --prefix frontend
pip install -r mtproto/requirements.txt
```

Запустить backend и Vite в двух терминалах:

```bash
npm run dev
npm run dev --prefix frontend
```

Backend слушает `http://localhost:3000`, Vite — `http://localhost:5173` и проксирует `/api` на
backend. Без `DATABASE_URL` локальный backend запускается в ограниченном DB-less режиме.

MTProto нужен только для реальных Telegram-запросов. После настройки его переменных запустить в
третьем терминале:

```bash
python mtproto/service.py
```

Локальный collector настраивается отдельно по [`collector/README.md`](collector/README.md).

## Проверки

```bash
npm run check
npm test --prefix frontend
npm run build --prefix frontend
python -m py_compile mtproto/service.py collector/pulse_collector.py
```

Для локального Playwright smoke:

```bash
npm run test:e2e:smoke --prefix frontend
```

CI поднимает Postgres для backend integration tests и Vite с детерминированными fixtures для
Playwright. Реальные Telegram/Instagram credentials и внешние API в CI не используются.

## Релиз

`main` автоматически разворачивается на Railway, поэтому каждое изменение идёт отдельным PR.
Worker-агент оставляет проверенный diff без commit/push/deploy; интегратор (Codex или человек)
проверяет результат, коммитит, ждёт зелёный CI и сливает PR.

- `Dockerfile.web` собирает frontend и запускает Node.js/Express.
- `Dockerfile.mtproto` запускает приватный Python/Telethon-сервис.
- После релиза проверяются `GET /api/health`, `GET /api/ready`, новый frontend asset и изменённый
  пользовательский сценарий на `https://atlavue.app`.

Перед миграцией или массовой операцией использовать
[`ops/BACKUP_RESTORE.md`](ops/BACKUP_RESTORE.md).

## Безопасность

- Управляемые Telegram-сессии и Instagram-токены хранятся только зашифрованно.
- API-ключи collector хранятся как SHA-256; исходный ключ показывается один раз.
- Любой tenant-доступ проходит ownership/role-check.
- GDPR export не включает хеш пароля, encrypted integration secrets и session payload.
- Telethon зафиксирован на `1.43.2`; обновление требует проверки Telegram TL-layer и сбора постов.
