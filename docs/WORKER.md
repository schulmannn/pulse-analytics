# Отдельный job-worker (второй Railway-сервис)

Готовность к выносу фоновых джоб из web-процесса в отдельный процесс `server/worker.js`
(`npm run worker`). Зачем: web не должен делить CPU и event loop с длинными фоновыми
проходами (IG/TG/МС-сборы, страничные прогоны бэкфилла) — иначе тяжёлый проход
задерживает живые HTTP-ответы дашборда.

## Топология джоб

**Периодические планировщики** (их и гейтит `JOBS_MODE`):

| Бегунок | Что гоняет | Кто стартует |
| --- | --- | --- |
| collection recovery runner (`infrastructure/collectionRecoveryRunner`) | IG-проход (`persistenceJob.runIgCollectionPass` → `instagramCollectionJob` per-account), TG QR-батч + central media repair (`tgQrCollectionJob`), дневной МС-сбор (`msCollectionJob.runMsCollectionPass`), доливка/resume заказов МС (`msBackfillEngine.runMsOrdersPass`) | web в `inline` (после listen) **или** worker (`COLLECTION_RECOVERY_MODE=worker`) |
| operational runner (`infrastructure/operationalRunner`) | scheduled-отчёты (`reportScheduleJob.processReportSchedules`) + дневная maintenance (`persistenceJob.runDailyMaintenanceOnce`) | **только web** (worker строит его, но никогда не стартует) |

**Request-driven (вне `JOBS_MODE`, всегда работают на web в обоих режимах):**

- `POST /api/ingest/daily` — дневной TG-ingest (`dailyIngestJob`) + его хвосты
  (отчёты/персистенс/TG QR); внешний крон, гейт по `x-ingest-token`.
- `POST /api/ms/backfill` — kick чанкового бэкфилла заказов МС: движок `msBackfillEngine`
  живёт в композиции web-процесса, роут запускает его fire-and-forget **в самом web** —
  это по-запросу работа, `JOBS_MODE` её не касается. Прогресс — durable в
  `ms_backfill_state` (heartbeat каждой страницей); `runMsOrdersPass` в worker подхватывает
  resume ТОЛЬКО брошенные прогоны (heartbeat старше ~10 мин), свежий web-прогон он не
  дублирует — координация межпроцессная, через БД, а не через in-process single-flight.

## Режимы

- `JOBS_MODE=inline` (дефолт, переменная не задана) — прежнее поведение: web гоняет всё.
- `JOBS_MODE=off` — web НЕ планирует периодические джобы (оба бегунка собраны, но не
  стартуют). HTTP/health и вся request-driven работа — как раньше. Неизвестное значение
  `JOBS_MODE` фатально на boot (молчаливый фолбэк в inline рядом с worker удвоил бы джобы).
- Worker (`npm run worker`) **игнорирует** `JOBS_MODE` — его смысл всегда гонять джобы;
  требует `COLLECTION_RECOVERY_MODE=worker` и живую БД (иначе падает явно, не работает
  вхолостую). HTTP-listener не поднимает.

## Как включить на Railway

1. Второй сервис из того же repo и того же `Dockerfile.web`, Start Command: `npm run worker`
   (включает прогон миграций, как `npm start`; параллельный старт с web безопасен —
   `server/migrations.js` берёт `pg_advisory_lock`).
2. Те же env, что у web-сервиса. `DATABASE_URL` — приватный (`*.railway.internal`),
   **без ssl** — канон репо; внешний URL — relaxed ssl. Дополнительно на worker-сервисе:
   `COLLECTION_RECOVERY_MODE=worker`. `PORT` worker'у не нужен.
3. На **web**-сервисе выставить `JOBS_MODE=off`.

### Порядок деплоя

1. Сначала поднять worker-сервис и убедиться в логах: `[worker] Atlavue recovery worker
   запущен (без HTTP-listener)`.
2. Сразу после — выставить `JOBS_MODE=off` на web (редеплой). Короткое перекрытие проходов
   между шагами 1 и 2 переживается durable/идемпотентными per-day/per-item гейтами джоб
   (`runJobOnce`, reservation-гейты), но оставлять оба гонять джобы надолго **нельзя**.

### Откат

1. Остановить/удалить worker-сервис.
2. Затем убрать `JOBS_MODE` с web (вернётся `inline`, web снова гоняет всё сам).

Именно в этом порядке: убрать `JOBS_MODE` при живом worker = оба процесса планируют джобы.

## Инварианты (ЯВНО)

- **ADR-002: ровно одна реплика каждого процесса** (один web, один worker). Двойной запуск
  джобов недопустим: либо `inline` (web один гоняет всё), либо `off` + worker — **не оба**.
  `WEB_REPLICAS > 1` и так запрещён конфигом.
- Operational-бегунок (scheduled-отчёты + дневная maintenance) — **web-only**: worker его не
  стартует. При `JOBS_MODE=off` отчёты и maintenance достигаются только хвостом
  `POST /api/ingest/daily` (внешний крон) — то есть off-режим возвращает им прежнюю
  зависимость от этого крона. Перенос operational-бегунка в worker — отдельный шаг
  (потребует снять web-only-инвариант и обновить worker-тесты).
- Гейты парные: web-entrypoint отвергает `COLLECTION_RECOVERY_MODE=worker`,
  worker-entrypoint требует его — случайно запустить не тот процесс нельзя.

Тесты: `test/worker_lifecycle.test.js` (worker), `test/jobs_mode.test.js` (web-гейт),
`test/main_lifecycle.test.js` (жизненный цикл web).
