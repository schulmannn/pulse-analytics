# Codex changes

Дата и время: 2026-06-25 05:57:14 (America/Buenos_Aires)

- Добавлен локальный Telegram collector (`collector/pulse_collector.py`) с режимами `doctor`, `once`, `run`, `flush`.
- Добавлен Docker-образ collector (`Dockerfile.collector`); Telegram-сессия остаётся на стороне пользователя.
- Добавлена локальная SQLite-очередь неотправленных payload, exponential backoff и безопасный повтор доставки.
- Введён версионированный collector-контракт v1: `schema_version`, `ingest_id`, `collector_version`, `collected_at`.
- Добавлен endpoint совместимости `/api/collector/compatibility`.
- Добавлена строгая нормализация payload: числовые диапазоны, лимиты строк/массивов/вложенности и защита от prototype pollution.
- Сохранена временная совместимость со старым collector payload с детерминированным legacy `ingest_id`.
- Добавлена идемпотентность ingest через таблицу `ingest_receipts`; повторный `ingest_id` не применяет данные дважды.
- Snapshot, история, посты, velocity, mentions и receipt теперь записываются одной PostgreSQL-транзакцией.
- Последовательные row-by-row upsert заменены на bulk upsert через `jsonb_to_recordset`.
- Добавлены `collector_status`, возраст последнего успешного ingest и предупреждение об устаревшем collector.
- DDL вынесен из запуска web-приложения в версионированные SQL-миграции `server/migrations/*.sql`.
- Добавлен отдельный migration runner с PostgreSQL advisory lock; `npm start` выполняет миграции перед web.
- Добавлен `package-lock.json`, Docker web переведён на воспроизводимый `npm ci`.
- Добавлен server-side отзыв пользовательских сессий через `users.token_version`.
- Logout, смена/сброс пароля, изменение роли или статуса теперь отзывают ранее выданные сессии.
- Auth-криптография и password hashing вынесены в отдельный модуль `server/lib/auth.js`.
- Tenant resolution вынесен в `server/middleware/tenant.js`; добавлены тесты запрета доступа пользователя A к каналу пользователя B.
- Collector routes и contract вынесены из монолитного `server/index.js` в отдельные модули.
- Настройки каналов/collector вынесены из монолитного `public/index.html` в `public/js/collector-settings.js`.
- CSP обновлён для разрешения собственных внешних JS-модулей при сохранении nonce для inline-скриптов.
- Добавлены structured JSON request logs и correlation `X-Request-Id`.
- Добавлены liveness `/api/health` и readiness `/api/ready` с проверкой Postgres.
- Добавлен security audit trail для входов, выходов, смены пароля, каналов, API-ключей и ingest без хранения секретов и сырых IP.
- Добавлен endpoint `/api/channels/:id/collector-status` и статус collector в личном кабинете.
- Добавлены Node-тесты auth, collector contract, duplicate ingest handler и tenant isolation.
- Добавлены Python-тесты персистентной очереди и retry delay.
- Добавлен GitHub Actions CI для JS-тестов, Python compile/tests и проверки inline-JS.
- Обновлены README, ROADMAP и CLAUDE.md под новую архитектуру, collector и процедуру миграций.
