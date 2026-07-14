# CLAUDE.md — Atlavue

Правила репо для Claude Code и автономных правок. **Сначала прочитай
[`PROJECT_MEMORY.md`](PROJECT_MEMORY.md)** — там текущее состояние, инварианты и план.

## Границы работника
- **Не коммить, не push, не merge, не deploy** и не трогай секреты/историю git. Результат —
  проверенный diff в выделенном рабочем дереве и короткий handoff интегратору.
- `main` авто-деплоится на Railway: **merge в `main` = прод**. Интегратор самостоятельно ревьюит
  diff, запускает проверки, создаёт PR и отвечает за выпуск.

## Архитектура (entry points)
- **`server/`** — Node/Express: `config.js` → `app.js` (роуты/middleware) → `composition.js`
  (сборка зависимостей) → `main.js` (boot), entry — `index.js`. Домен разложен по
  `routes/` → `services/` → `repos/` → `db/` (+ `jobs/`, `infrastructure/`, `middleware/`,
  `lib/`); фасад `db.js` сохраняет форму вызовов.
- **`server/migrations/*.sql`** — forward-only, применяются на старте (`npm start`).
- **`frontend/`** — React 18 + Vite + TS (strict), TanStack Query + Zod и Tailwind;
  build → `frontend/dist`, отдаётся Express на `/`. Канон дизайна — `frontend/DESIGN_TOKENS.md`.
- **`mtproto/service.py`** — Python/FastAPI + Telethon, приватный `:8001`.
- **`collector/pulse_collector.py`** — локальный агент пользователя (SQLite queue/retry).

## Проверки
- CI поднимает Postgres и выполняет backend integration suites через `TEST_DATABASE_URL`.
- Frontend e2e поднимает Vite и использует детерминированные fixtures; реальных Telegram/Instagram
  credentials в раннере нет.
- `npm run check` — `check:syntax` + `check:migrations` + `check:boundaries` + Biome-lint + `node --test`.
- Фронт: `npm test --prefix frontend`, затем `npm run build --prefix frontend`; для затронутого
  пользовательского пути — целевой Playwright spec или `npm run test:e2e:smoke --prefix frontend`.
- Python: `python -m py_compile mtproto/service.py collector/pulse_collector.py`.
- Логику эндпоинтов/чистых функций — юнит-тестами: заглушки `telethon`/`fastapi` через
  `sys.modules` + фейковый async-клиент.

## Графики
- Все SVG в фикс. `viewBox` + `preserveAspectRatio="none"` растягиваются неравномерно →
  обводки **обязаны** иметь `vector-effect="non-scaling-stroke"`, иначе stroke «размазывает».
- Длинные серии (история до 730 дн) даунсэмплятся через `lttbDownsample(...)` до
  `CHART_MAX_POINTS` перед рендером, иначе суб-пиксельная мазня.

## Ключевые грабли (НЕ повторять)
- **Telethon ≥ 1.43.2** обязателен (старые не парсят TL-layer → посты/просмотры = 0).
- `GetMessageStats.views_graph` — **инкрементальный, дневной** (не кумулятивный/почасовой).
- Альбомы схлопывать по `grouped_id` (иначе двойной счёт постов/просмотров).
- Railway приватный `DATABASE_URL` (`*.railway.internal`) — **без ssl**; внешний — relaxed ssl.
- `channels.searchPosts` (упоминания) — квота ~10/день; ходить только по кнопке.
- ingest-токен слать **заголовком** `x-ingest-token` (в URL-query спецсимволы ломаются).
- Collector contract требует `schema_version`, `ingest_id`, `collector_version`, `collected_at`;
  повторный `ingest_id` обязан быть безопасным (идемпотентность).
- Новая схема — отдельным SQL-файлом в `server/migrations/`, **не** DDL в boot-коде.
- Любой tenant-read/write проходит ownership/role-check (`getChannel`/`makeResolveChannel`/
  `hasWorkspaceRole`) и содержит `channel_id`.
- TG-просмотры и IG-охват — разные метрики, **никогда** не суммировать в одно число.
- Выбранный источник не должен меняться из-за перехода между страницами или порядка ответа API.
- Не размножать источники в сайдбаре: один глобальный source context, а локальные фильтры только
  там, где рабочей поверхности действительно нужен срез по нескольким источникам.
- До отдельного старта mobile-этапа не переделывать мобильный UI. Desktop-изменение обязано
  сохранять существующее мобильное поведение и не добавлять горизонтальный overflow.

## Стиль
Минимальные хирургические правки в духе окружающего кода; русские строки в UI; не вводить
новые зависимости без необходимости; новое поле в БД — новой идемпотентной миграцией
(`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
