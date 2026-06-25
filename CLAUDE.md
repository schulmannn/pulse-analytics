# CLAUDE.md — pulse-analytics

Дашборд аналитики Telegram-канала (+задел под Instagram). Этот файл — конвенции репо
для автономных правок (в т.ч. для GitHub Action, который чинит баги из трекера).

## Архитектура
Два Railway-сервиса и локальный пользовательский collector:
- **`server/index.js`** — Node/Express: отдаёт фронт + API на публичном `$PORT`,
  проксирует `/api/tg/mtproto/*` на Python-сервис, владеет Postgres (`server/db.js`).
- **`server/routes/collector.js`** + **`server/collector/contract.js`** —
  версионированный/идемпотентный collector ingest.
- **`server/migrations/*.sql`** — SQL-миграции; `npm start` запускает их до web.
- **`public/index.html`** + **`public/js/`** — vanilla JS, графики — **hand-built
  inline-SVG** (без чарт-библиотек).
- **`mtproto/service.py`** — Python/FastAPI + Telethon (MTProto) на внутреннем `:8001`.
- **`collector/pulse_collector.py`** — локальный агент пользователя с SQLite queue/retry.
- **`server/db.js`** — Postgres (опционально): без `DATABASE_URL` всё мягко выключается.

## ⚠️ Деплой: push в `main` = прод
`main` авто-деплоится на Railway при пуше. Поэтому **НИКОГДА не коммить напрямую в `main`
и не мёржи сам** — только **открывай PR против `main`**. Решение о мёрже — за человеком.

## Как проверять без сети (CI не поднимет живое приложение)
Нет Telethon-сессии / Postgres / реальных данных TG в раннере. НЕ пытайся запустить
приложение. Проверяй статикой:
- Сервер: `node --check server/index.js`, `node --check server/db.js`.
- Инлайн-JS фронта: распарсить через `vm.Script` (см. ниже) — не `node --check` по .html.
- Python: `python -m py_compile mtproto/service.py collector/pulse_collector.py`.
- Полный локальный набор: `npm run check`.
- Логику реальных эндпоинтов/чистых функций гоняй юнит-тестами, подсовывая заглушки
  `telethon`/`fastapi` через `sys.modules` + фейковый async-клиент; чистые JS-функции —
  извлекая исходник из index.html и `eval`/`vm` в node.

Парс инлайн-JS:
```js
const fs=require('fs'),vm=require('vm');
const html=fs.readFileSync('public/index.html','utf8');
const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;let m;
while((m=re.exec(html))) new vm.Script(m[1]); // бросит на синтакс-ошибке
```

## Графики (важно для багов про «кривой/размытый график»)
- Все SVG в фикс. `viewBox` + `preserveAspectRatio="none"` → растягиваются неравномерно.
  Обводки ДОЛЖНЫ иметь `vector-effect="non-scaling-stroke"`, иначе stroke «размазывает».
- Длинные серии (история до 730 дн) даунсэмплятся через `lttbDownsample(...)` до
  `CHART_MAX_POINTS=140` перед рендером, иначе суб-пиксельная мазня.
- Модалка графика (`openChartModal`) клонирует панель → **id дублируются**; внутри клона
  не используй `getElementById`, работай по элементу (`applyYAxisEl`, `scope.querySelector`).

## Ключевые грабли (НЕ повторять)
- **Telethon ≥ 1.43.2** обязателен (старые не парсят TL-layer → посты/просмотры = 0).
- `GetMessageStats.views_graph` — **инкрементальный, дневной** (не кумулятивный/почасовой).
- Альбомы схлопывать по `grouped_id` (иначе двойной счёт постов/просмотров).
- Railway приватный `DATABASE_URL` (`*.railway.internal`) — **без ssl**; внешний — relaxed ssl.
- `channels.searchPosts` (упоминания) — квота ~10/день; ходить только по кнопке.
- ingest-токен слать **заголовком** `x-ingest-token` (в URL-query спецсимволы ломаются).
- Collector contract v1 требует `schema_version`, `ingest_id`, `collector_version`,
  `collected_at`; повторный `ingest_id` обязан быть безопасным.
- Не добавлять DDL обратно в boot-код: новая схема идёт отдельным SQL-файлом в
  `server/migrations/`.
- Любой tenant-read/write обязан проходить ownership check (`getChannel` /
  `makeResolveChannel`) и содержать `channel_id`.
- Баги/история/упоминания живут в Postgres; всё за `requireAuth` (общий `TEAM_PASSWORD`).

## Стиль
Минимальные хирургические правки в духе окружающего кода; русские строки в UI; не вводить
новые зависимости без необходимости; если добавляешь поле в БД — новой идемпотентной
миграцией (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
