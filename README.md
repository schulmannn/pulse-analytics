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

Ротация managed-сессий выполняется одним deploy: новый ключ задаётся в `TG_SESSION_KEY`, а прежние
(не более трёх) временно перечисляются в `TG_SESSION_KEY_PREVIOUS`. Старые записи читаются через fallback
и при первом использовании generation-safe перешифровываются активным ключом; предыдущие ключи нельзя
удалять, пока все нужные сессии не были успешно использованы после ротации.

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
| `TG_SESSION_KEY_PREVIOUS` | web | до трёх прежних TG-ключей через запятую: только fallback-чтение и lazy re-encryption; активный write-key всегда `TG_SESSION_KEY` |
| `TG_API_ID`, `TG_API_HASH` | mtproto/collector | Telegram application credentials |
| `TG_SESSION`, `TG_CHANNEL` | mtproto | служебная управляемая Telegram-сессия и канал, если используются |
| `IG_CLIENT_ID`, `IG_CLIENT_SECRET`, `IG_TOKEN_KEY` | web | Instagram Login и шифрование account token |
| `IG_OAUTH_MAX_INFLIGHT` | web | предел одновременных Instagram OAuth callback-обменов, по умолчанию `8`, диапазон `1..64`; очередь ожидания ограничена тем же числом |
| `IG_OAUTH_ACQUIRE_TIMEOUT_MS` | web | сколько callback ждёт свободный OAuth-слот перед честным `busy`, мс, по умолчанию `2000`, диапазон `100..10000` |
| `INGEST_TOKEN` | web/cron | авторизация daily ingest через `x-ingest-token` |
| `COLLECTOR_STALE_HOURS` | web | порог устаревания collector, по умолчанию 24 часа |
| `CACHE_MAX_ENTRIES` | web | верхняя граница числа записей in-memory LRU-кэша ответов, по умолчанию `2000`, диапазон `100..10000` |
| `CACHE_TTL_MS` | web | абсолютный TTL записи кэша (не продлевается на чтении), мс, по умолчанию `600000` (10 мин), диапазон `1000..3600000` |
| `IG_ACCOUNTS_PER_PASS` | web/worker | сколько НОВОСТАРТОВАННЫХ IG-аккаунтов сбор трогает за один проход (durable per-account/day), по умолчанию `25`; завершённые за день пропускаются и лимит не тратят |
| `TG_QR_CHANNELS_PER_PASS` | web/worker | сколько НОВОСТАРТОВАННЫХ QR-каналов TG-сбор трогает за один проход, по умолчанию `200` |
| `TG_MEDIA_REPAIR_PER_PASS` | web/worker | сколько недостающих обложек central Telegram recovery запрашивает за один bounded-проход, по умолчанию `16`, максимум `16` |
| `TG_MEDIA_REPAIR_WINDOW_DAYS` | web/worker | глубина архива central Telegram для фонового добора обложек, по умолчанию `365`, диапазон `1..3650`; durable 6-часовые buckets ограничивают ретраи |
| `JOBS_RETENTION_DAYS` | web | сколько дней ночная maintenance держит ТЕРМИНАЛЬНЫЕ строки `jobs` (succeeded/failed, по `updated_at`) перед bounded-прунингом, по умолчанию `30`, диапазон `1..3650`; `queued`/`running` не трогаются никогда |
| `EMAIL_TOKENS_RETENTION_DAYS` | web | сколько дней держатся МЁРТВЫЕ `email_tokens` (использованные или истёкшие, по `created_at`) перед bounded-прунингом, по умолчанию `30`, диапазон `1..3650`; валидный неиспользованный токен не удаляется |
| `COLLECTION_RECOVERY_INITIAL_DELAY_MS` | web/worker | задержка первого прохода recovery-бегунка после старта, мс, по умолчанию `30000`, минимум `1000` |
| `COLLECTION_RECOVERY_INTERVAL_MS` | web/worker | период повторных проходов recovery-бегунка, мс, по умолчанию `900000` (15 мин), минимум `60000` |
| `COLLECTION_RECOVERY_MODE` | web/worker | где исполняется recovery-бегунок: `inline` (дефолт — web в себе, как раньше), `external` (web не планирует бегунок), `worker` (отдельный процесс `server/worker.js` без HTTP). Web отвергает `worker`, worker требует `worker` |
| `OPERATIONAL_RUNNER_INITIAL_DELAY_MS` | web | задержка первого прохода operational-бегунка (scheduled-отчёты + дневная maintenance) после старта, мс, по умолчанию `60000`, минимум `1000` |
| `OPERATIONAL_RUNNER_INTERVAL_MS` | web | период повторных проходов operational-бегунка, мс, по умолчанию `3600000` (1 час), минимум `60000`; maintenance при этом идёт раз в UTC-сутки (durable per-day gate), отчёты — раз в период (durable reservation) |
| `REPORT_DISPATCH_CONCURRENCY` | web | сколько due-отчётов рассылается параллельно за один проход, по умолчанию `2`, диапазон `1..8`; подтверждённый провайдерский 429 ставит pass-scoped паузу, и новые отчёты после неё не стартуют |

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

### Recovery-бегунок: один или два сервиса

По умолчанию recovery-бегунок фонового сбора живёт внутри web-процесса (`COLLECTION_RECOVERY_MODE=inline`
или переменная не задана) — поведение прежних деплоев не меняется. Чтобы вынести сбор в отдельный
Railway-сервис (при росте CPU/network нагрузки), настраиваются два сервиса на общей `DATABASE_URL`:

- **web** — `COLLECTION_RECOVERY_MODE=external`, start `npm start` (`node server/migrate.js && node server/index.js`).
  Web перестаёт планировать бегунок, но продолжает отдавать SPA/API.
- **worker** — `COLLECTION_RECOVERY_MODE=worker`, start `npm run worker`
  (`node server/migrate.js && node server/worker.js`). Процесс не поднимает HTTP-listener, владеет только
  бегунком и завершается по SIGTERM с bounded-дренажем.

Оба процесса делят durable item-level leases сбора, поэтому пересекающиеся проходы остаются
идемпотентными. Ограничение одной web-реплики (`WEB_REPLICAS=1`) не ослабляется. Web отказывается
стартовать в режиме `worker`, а worker — в режимах `inline`/`external` и при выключенной БД, поэтому
неверная конфигурация падает явно, а не собирает данные вхолостую или дважды.

Перед миграцией или массовой операцией использовать
[`ops/BACKUP_RESTORE.md`](ops/BACKUP_RESTORE.md).

## Безопасность

- Управляемые Telegram-сессии и Instagram-токены хранятся только зашифрованно.
- API-ключи collector хранятся как SHA-256; исходный ключ показывается один раз.
- Любой tenant-доступ проходит ownership/role-check.
- GDPR export не включает хеш пароля, encrypted integration secrets и session payload.
- Telethon зафиксирован на `1.43.2`; обновление требует проверки Telegram TL-layer и сбора постов.
