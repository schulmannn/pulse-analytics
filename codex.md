# codex.md — доска задач (босс: Claude, исполнитель: Codex)

Это общий файл координации. **Claude** ставит задачи, **Codex** реализует их прямо в
репозитории и отчитывается здесь же. Claude ревьюит дифф и мержит/пушит.

## Как это работает

1. Claude добавляет задачи в раздел **«## Задачи»** со статусом: 🟢 active · ⏸ queued · ✅ done · 🔴 blocked.
2. Codex берёт **активную** (🟢) задачу, реализует её в коде, гоняет билд, затем заполняет
   блок **«#### Отчёт Codex»** под задачей (что менял, как проверил, сомнения/решения) и
   ставит статус ✅ (или 🔴 + причина).
3. Claude ревьюит дифф, при необходимости правит, и пушит. Новые задачи — снова сюда.

## Протокол работы Codex (важно)

- Перед работой: `git pull` (на ветке `main`).
- **Не пушить в `main`.** Оставь изменения в рабочем дереве **или** в ветке `codex/<task-id>` —
  Claude отревьюит и запушит сам.
- **Не трогать** `public/index.html` (старый дашборд, живёт до катовера), CSP в `server/index.js`,
  `Dockerfile.web`, секреты. Катовер (3F-3) делает Claude.
- Перед отчётом: `cd frontend && npm run build` **должен быть зелёным** (`tsc --noEmit && vite build`).
  Приложи хвост вывода в отчёт.

## Контекст проекта

Strangler-fig миграция дашборда аналитики. Новый фронт — `frontend/` (Vite + React 18 + TS
strict + Tailwind3 + shadcn + TanStack Query + Zod), Express отдаёт его под **`/app`** рядом
со старым `public/index.html` на `/`. Все data-панели уже мигрированы (Обзор, Аналитика,
Графики, Посты, Упоминания, Настройки, Админ, Баги) + навигация на react-router.
**Все конвенции и паттерны — в [`frontend/README.md`](frontend/README.md). Прочитай его первым.**

## Правила (ОБЯЗАТЕЛЬНО)

- 🎨 **Дизайн — НЕ твоя зона.** Переиспользуй существующие компоненты (`@/components/ui/card`,
  `Breakdown`, `BarChart`, `LineChart`, `DivergingBars`) и **семантические Tailwind-токены**
  (`bg-card`, `text-foreground`, `text-muted-foreground`, `text-primary`, `border`, бренд
  `text-iris/verdant/ember`). **Никаких новых цветов/hex.** Где нужен принципиально новый
  layout — делай **минимально и функционально**, помечай `<!-- DESIGN: Claude review -->`,
  визуал отполирует Claude.
- Паттерн данных: Zod-схема (пермиссивная: `optional/nullable/passthrough`, `z.coerce.number`)
  → `useQuery`/`useMutation` в `src/api/queries.ts` → панель. HTTP — только через
  `apiGet`/`apiSend` (`src/api/client.ts`); они сами шлют `X-Session-Token`.
- TS strict: **без `any`** (типизируй или structural-тип); **без `import React`** (включён
  automatic JSX-runtime — `noUnusedLocals` уронит сборку); типы событий/узлов —
  `import type { FormEvent, ChangeEvent, ReactNode } from 'react'` (НЕ `React.FormEvent` —
  это ts2686); импорты через алиас `@/`.
- Мутации: `useMutation` + `onSuccess: () => qc.invalidateQueries(...)` (refetch-after-mutate).
- Не вводи новые npm-зависимости без явного разрешения в задаче. При разрешённой новой
  зависимости — ставь версию, **совместимую с нашим `vite 5` / `React 18`** (проверь её
  `peerDependencies`! напр. `vitest@4` пир-требует `vite ^6` → бери `vitest@^3`). После
  добавления прогони **чистый `npm ci`** (а не только `npm install`) — peer-конфликт всплывает
  именно на `npm ci` (Docker/Railway), а локальный `npm install`/`build` его маскирует.

---

## Задачи

### ✅ TASK-001 — Channel switcher + `X-Channel-Id` (мультитенантность)

**Зачем.** Мультиканальность на бэке работает через заголовок `X-Channel-Id` (см. легаси
`public/index.html` ~стр. 2137: `API.req` шлёт `X-Channel-Id: SELECTED_CHANNEL` на каждый
запрос). Новый клиент его **не шлёт** → юзер с несколькими каналами всегда видит дефолтный
канал. У владельца сейчас 1 central-канал (свитчер скрыт), но через панель «Настройки» уже
можно добавить collector-канал — после этого переключение должно работать.

**Что сделать:**
1. **Стор выбранного канала**, читаемый из API-клиента вне React. Рекомендую новый модуль
   `src/lib/channel.ts`: `getSelectedChannel(): number | null`, `setSelectedChannel(id: number | null)`
   на модульной переменной (аналог легаси `SELECTED_CHANNEL`). Опц. персист в `localStorage`.
2. В `src/api/client.ts`: **и `apiGet`, и `apiSend`** добавляют заголовок
   `X-Channel-Id: String(id)`, когда `getSelectedChannel() != null`.
3. **Свитчер в шапке** `src/components/DashboardLayout.tsx`: `<select>`, наполняемый из
   `useChannels()` (`src/api/queries.ts`; ответ `{enabled, channels[], selected}`,
   `ChannelSchema` = `{id, username, title, source, …}`). **Скрывать при `channels.length < 2`**
   (как легаси `renderChannelSwitcher` ~стр. 4757). Лейбл опции: `@${c.username || c.title || c.id}`.
   Стиль `<select>` — как в `src/panels/Admin.tsx` (не выдумывай новый вид).
4. **Инициализация выбора**: из поля `selected` ответа `/api/channels` (иначе первый канал).
   Вызови `setSelectedChannel(initial)` при загрузке списка.
5. **При смене канала**: `setSelectedChannel(id)` + `queryClient.invalidateQueries()` (без
   аргумента — инвалидировать всё), чтобы все панели перезапросили данные под новый канал
   (`useQueryClient()` из TanStack доступен в компоненте свитчера).

**Не делать:** период-фильтр, auth, дизайн-редизайн шапки. Только свитчер + проброс заголовка.

**Критерии приёмки:**
- `cd frontend && npm run build` зелёный.
- При `channels.length < 2` свитчера нет, поведение не меняется.
- При ≥2 каналах: выбор канала → `X-Channel-Id` уходит на `/api/tg/*`, `/api/history/*`,
  `/api/ig/*`, и панели перезапрашиваются (видно в Network/в обновлении данных).
- `getSelectedChannel()` читается синхронно из `apiGet`/`apiSend` (не через React-хук).

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/lib/channel.ts` — синхронный модульный стор выбранного канала.
- `frontend/src/api/client.ts` — `apiGet` и `apiSend` добавляют `X-Channel-Id`, когда канал выбран.
- `frontend/src/components/DashboardLayout.tsx` — свитчер из `useChannels()`, скрытый при `< 2` каналах; инициализация из `selected`/первого канала и полная инвалидация query-кэша при смене.
- `codex.md` — статус задачи и отчёт.

Хвост `cd frontend && npm run build`:
```text
✓ 119 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                  0.71 kB │ gzip:   0.39 kB
dist/assets/index-DXG_Pph5.css  22.39 kB │ gzip:   5.06 kB
dist/assets/index-DskEtBxb.js  368.71 kB │ gzip: 106.47 kB
✓ built in 2.95s
```

Решения/сомнения:
- Переиспользованы существующие `ChannelSchema`, `ChannelsResponseSchema`, `useChannels()` и классы `<select>` из `Admin.tsx`; новых цветов и зависимостей нет.
- Стор оставлен модульным без `localStorage`: персист был опциональным, а серверный `selected` остаётся источником начального выбора.
- Сомнений по реализации нет.

**Ревью Claude — ✅ одобрено, замёржено в `main` (commit `64c2285`).** Дифф строго по скоупу;
типы/токены чистые, `import type` корректен, `npm run build` зелёный, запретное (index.html/CSP/
Dockerfile) не тронуто. Мелочь на потом (не блокер): при мультиканале начальная установка канала
не инвалидирует кэш — если серверный дефолт ≠ `channels[0]`, первый рендер покажет дефолтный канал
до ручной смены. Для 1 канала неактуально; вернёмся при подключении 2-го. **Хорошая работа.**

---

### ✅ TASK-002 — Auth в новом аппе (ЛОГИКА; дизайн форм/лендинга — за Claude)

**Зачем.** Сейчас логин только через старый дашборд `/` (новый апп читает общий
localStorage-токен `pulse_token`). Это **блокер катовера 3F-3**: когда `/` станет новым аппом,
ему нужен собственный вход.

**Скоуп Codex (логика, на существующих UI-примитивах — без нового дизайна):**
- Прочитать в `server/index.js` хендлеры `/api/auth/*` (login ~299, register ~273, verify ~350/359,
  forgot ~374, reset ~391, resend ~408, logout ~329) — снять точные тела запросов/ответов
  (в частности: возвращает ли `login` токен в теле — его надо положить в localStorage через
  helper в `src/lib/session.ts`).
- `src/lib/session.ts`: добавить `setSessionToken(token, ttlMs?)` / `clearSessionToken()`
  (ключи `pulse_token` + `pulse_token_exp`, как легаси).
- `src/api/queries.ts`: мутации `useLogin/useRegister/useVerify/useForgot/useReset/useLogout`
  (через `apiSend`).
- Роуты `/login`, `/register`, `/verify`, `/reset` (react-router) + **guard**: незалогиненный
  → `/login` (заменить текущий «иди на старый дашборд»); после успешного логина —
  `setSessionToken` + редирект в `/` (Обзор).
- Формы — **функциональные, на существующих `Card`/`input`/`button`-классах из панелей**.
  **Лендинг и визуальный дизайн форм НЕ делаешь** — оставь функциональный минимум с пометкой
  `<!-- DESIGN: Claude review -->`, дизайн доведёт Claude.

**Критерии приёмки:** build зелёный; существующий верифицированный юзер логинится прямо в новом
аппе (токен в localStorage, редирект на Обзор); logout чистит токен и кидает на `/login`.

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/lib/session.ts` — добавлены `setSessionToken`/`clearSessionToken`, TTL по умолчанию 8 часов.
- `frontend/src/api/schemas.ts` — permissive Zod-схемы ответов login и остальных auth-операций.
- `frontend/src/api/queries.ts` — `useLogin/useRegister/useVerify/useForgot/useReset/useLogout` через `apiSend`.
- `frontend/src/pages/Auth.tsx` — функциональные формы login/register/verify/reset и forgot-режим формы входа; оставлена пометка `DESIGN: Claude review`.
- `frontend/src/App.tsx` — публичные auth-роуты и guard с редиректом неавторизованного пользователя на `/login`.
- `frontend/src/components/DashboardLayout.tsx` — logout с очисткой сессии и редиректом на `/login`.
- `frontend/src/main.tsx` — React runtime переведён на именованные импорты без `import React`.
- `codex.md` — статус задачи и отчёт.

Хвост `cd frontend && npm run build`:
```text
✓ 120 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                  0.71 kB │ gzip:   0.39 kB
dist/assets/index-DXG_Pph5.css  22.39 kB │ gzip:   5.06 kB
dist/assets/index-DGBdZhVB.js  376.61 kB │ gzip: 108.24 kB
✓ built in 4.11s
```

Решения/сомнения:
- `/api/auth/login` действительно возвращает `token` и `expiresAt`; токен сохраняется до редиректа, TTL вычисляется из серверного `expiresAt`.
- Тела запросов совпадают с хендлерами: login/register `{email,password}`, verify `{token}`, forgot `{email}`, reset `{token,password}`, logout без тела.
- Logout очищает localStorage и при успешном ответе, и при сетевой/серверной ошибке.
- Текущие email-ссылки сервера всё ещё ведут на legacy `/api/auth/verify?token=...` и `/?reset=...`; новые `/verify?token=...` и `/reset?token=...` реализованы, но переключение URL писем относится к катоверу/серверному скоупу Claude.

**Ревью Claude — ✅ одобрено, замёржено в `main`.** Схемы сверены с сервером: `/api/auth/login`
реально отдаёт `{token, expiresAt, user}`, break-glass без email учтён; тела запросов совпадают;
guards/logout/redirect корректны; `npm run build` зелёный; правило №8 соблюдено; формы на
существующих примитивах с DESIGN-маркерами. Follow-up (мой скоуп, не блокеры):
🎨 визуальный полиш форм + лендинг; переключение серверных email-URL на `/verify`//`/reset` —
в рамках 3F-3; (+ из TASK-001) мультиканал-инит-синк. **Отличная работа.**

---

### ✅ TASK-003 — Глобальный период-фильтр (7 / 30 / 90 / 365 / Всё)

**Зачем.** Новый апп фиксирует окно данных (`useTgFull` limit 30 и т.п.). В легаси был
`currentPeriod` + кнопки периода — он управлял окном KPI/постов/heatmap/hashtags/digest.
Нужно вернуть глобальный селектор периода.

**Прочитай в легаси `public/index.html`:** `currentPeriod` (~2560, дефолт 7), кнопки периода
(`data-period`), `inRange(p)` / `customRange` (~2568) и масштабирование `tgLimit` от периода в
`loadAll` (~4790: `<=1?15 : <=7?30 : <=30?60 : 100`).

**Что сделать (БЕЗ нового дизайна — переиспользуй стили кнопок/табов из `DashboardLayout`/панелей):**
1. Период-стор как React-контекст: `PeriodProvider` + `usePeriod()` → `{ days, setDays }`,
   `days ∈ {7, 30, 90, 365, 0}` (0 = всё), дефолт **30**. Провайдер обернуть вокруг `<App/>`
   в `main.tsx` (внутри `QueryClientProvider`).
2. Селектор в шапке (`DashboardLayout`): сегмент-кнопки «7д / 30д / 90д / Год / Всё», активная
   подсвечена; стили — как у nav-табов (ничего нового). onClick → `setDays`.
3. Прокинуть период в данные:
   - `useTgFull(days)`: лимит через хелпер `tgLimit(days)` (≈ `days<=7?30 : days<=30?60 : 100`;
     all→100; сервер всё равно ≤100). **queryKey ОБЯЗАН включать `days`** (смена периода →
     раздельный кеш + рефетч).
   - Хелпер `inRangeByDays(dateISO, days)` (days=0 → `true`; иначе `date >= now - days·сутки`) —
     применить в панелях, фильтрующих посты по свежести: KPI, Posts, Heatmap, Hashtags, Digest
     (там, где легаси звал `inRange`). Панели берут `days` из `usePeriod()`.
4. НЕ трогать `useHistory` (архив подписчиков — всё-время) и `useVelocity`.

**Не делать:** кастомный диапазон дат (`customRange`) — пока только пресеты; редизайн.

**Критерии приёмки:**
- `cd frontend && npm run build` зелёный.
- Селектор виден, дефолт 30; смена периода → панели перезапрашивают/пересчитывают окно
  (queryKey с `days`). **`staleTime` в `main.tsx` НЕ убирай** (он гасит рефетч-шторм —
  именно из-за таких рефетчей по таймфреймам раньше ловили rate-limit).
- Дефолт (30 дн) ≈ текущее поведение.

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/lib/period.tsx` — `PeriodProvider`/`usePeriod`, тип пресетов, `tgLimit(days)` и `inRangeByDays(dateISO, days)`.
- `frontend/src/main.tsx` — `PeriodProvider` подключён внутри `QueryClientProvider`; `staleTime: 60_000` сохранён.
- `frontend/src/api/queries.ts` — `useTgFull(days)` масштабирует limit и использует `queryKey: ['tg-full', days]`.
- `frontend/src/components/DashboardLayout.tsx` — сегмент-кнопки `7д / 30д / 90д / Год / Всё` на существующих стилях nav-табов.
- `frontend/src/panels/Hero.tsx` — период передаётся в запрос и отражается в подписи.
- `frontend/src/panels/KpiGrid.tsx` — KPI и sparkline пересчитываются по постам выбранного периода.
- `frontend/src/panels/Posts.tsx` — топ и таблица фильтруются по выбранному периоду.
- `frontend/src/panels/Charts.tsx` — период применяется к постам тепловой карты; history/velocity не изменены.
- `frontend/src/panels/Hashtags.tsx` — расчёт lift выполняется по постам выбранного периода.
- `frontend/src/panels/Digest.tsx` — сводка, топ-пост и weekday-расчёт используют выбранный период.
- `frontend/src/panels/TgAnalytics.tsx` — период передаётся в `useTgFull`, legacy `inRange`-расчёты ERV/виральности фильтруются.
- `codex.md` — статус задачи и отчёт.

Хвост `cd frontend && npm run build`:
```text
✓ 121 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                  0.71 kB │ gzip:   0.39 kB
dist/assets/index-BVKWIWZm.css  22.41 kB │ gzip:   5.07 kB
dist/assets/index-DhYTdilb.js  377.86 kB │ gzip: 108.68 kB
✓ built in 3.02s
```

Решения/сомнения:
- Дефолт контекста — 30 дней; `tgLimit`: 7 → 30, 30 → 60, 90/365/всё → 100, как требовала задача с учётом серверного cap.
- Смена периода не делает ручную глобальную инвалидацию: новый `days` создаёт отдельный query cache entry и запускает нужный запрос, сохраняя защитный `staleTime`.
- `days=0` пропускает все посты, включая записи без даты; для остальных пресетов записи без валидной даты исключаются.
- Кастомный диапазон, `useHistory` и `useVelocity` не изменялись; сомнений по реализации нет.

**Ревью Claude — ✅ одобрено, замёржено в `main` (`933deef`).** `period.tsx` корректен (контекст,
`tgLimit` зеркалит легаси-масштабирование, `inRangeByDays` с защитой от невалидных дат);
`useTgFull(days)` — queryKey включает `days`, `staleTime` сохранён; `PeriodSwitcher` на
существующих tab-стилях (без нового дизайна); build зелёный, без `any`/`import React`.
Дефолт-30 ≈ прежнее поведение. **Отличная работа.**

---

### ✅ TASK-004 — Мультиканал: инвалидация при первичной установке канала

**Зачем.** В `ChannelSwitcher` (`DashboardLayout`, из TASK-001) при ПЕРВИЧНОЙ авто-установке
канала (`useEffect`) нет инвалидации кэша. Для ≥2 каналов, если серверный дефолт ≠ `channels[0]`,
первый рендер покажет данные дефолтного канала до ручной смены.

**Что сделать:** в init-эффекте `ChannelSwitcher` после `setSelectedChannel(initial)` вызвать
`queryClient.invalidateQueries()` — **только при `channels.length >= 2`** (для 1 канала дефолт-
резолюция корректна, лишний рефетч не нужен). Не создать цикл ре-рендеров / рефетч-шторм.

**Критерии приёмки:** build зелёный; для 1 канала поведение и число рефетчей не меняются;
для ≥2 каналов первичный выбор инвалидирует кэш ровно один раз.

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/components/DashboardLayout.tsx` — после первичной установки канала вызывается `queryClient.invalidateQueries()` только при `channels.length >= 2`; `queryClient` добавлен в зависимости эффекта.
- `codex.md` — статус задачи и отчёт.

Проверка:
```text
✓ 121 modules transformed.
✓ built in 4.59s
```

Решения/сомнения:
- При одном канале ветка инвалидации не выполняется.
- При двух и более каналах эффект инвалидирует кэш один раз: после установки локального `selectedChannelId` следующий запуск эффекта сразу выходит по guard `selectedChannelId != null`.
- Сомнений по реализации нет.

**Ревью Claude — ✅ одобрено, замёржено в `main` (`a4da1ab`).** Строка 133
`if (channels.length >= 2) void queryClient.invalidateQueries();` — ровно по спеке, guard от
петли на месте, build зелёный. ✓

---

### ✅ TASK-005 — Юнит-тесты ядра логики (Vitest)

**Зачем.** Перед катовером зафиксировать портированные формулы/хелперы, чтобы катовер и будущие
правки молча их не сломали.

**Разрешение на зависимости:** можно добавить dev-deps **vitest** (и при нужде
`@vitest/coverage-v8`). НЕ добавляй jsdom / Testing Library — тестируем ЧИСТУЮ логику, не
компоненты/DOM.

**Что сделать:**
1. Подключить vitest: конфиг (`vitest`-секция в `vite.config.ts` или отдельный `vitest.config.ts`),
   скрипт в `frontend/package.json`: `"test": "vitest run"`. `npm run build` (tsc + vite) НЕ
   должен сломаться (vitest идёт отдельно от build).
2. Тесты (`src/**/*.test.ts`) на чистые функции:
   - `lib/format.ts`: `fmt.num` (группировка, `—` на null/NaN), `fmt.short` (k/M, обрезка `.0`),
     `fmt.pct`, `sparkPath`/`sparkAreaPath` (форма/длина path). `greeting`/`todayLabel` зависят от
     времени — мокни `Date` или пропусти.
   - `lib/posts.ts`: `normalizeTgPosts` — `reach/likes/comments/shares/eng`, `erv=eng/reach*100`,
     `virality=shares/reach*100`, `er=eng/followers*100`, фоллбэк-цепочки (`views||view_count`…),
     `thumb`-URL для photo/video, `permalink`, фильтр `reactionsDetail` без emoji, `reach=0 →
     erv/virality=null`.
   - `lib/period.ts`: `tgLimit` (7→30, 30→60, 90/365/0→100), `inRangeByDays` (0→true; невалид/null
     →false; граница `now-days`).
   - `lib/downsample.ts`: `lttbDownsample` (`threshold>=n || <3` → исходный массив; сохраняет
     первый/последний элемент; длина = threshold для больших n).
3. Только чистые функции; без сети/DOM/React.

**Не трогать:** `.github/workflows/ci.yml` (CI подключу отдельно), серверные тесты в корне репо.

**Критерии приёмки:** `cd frontend && npm run build` зелёный; `npm test` (vitest run) зелёный;
тесты реально проверяют формулы (значимые ассерты, не заглушки). В отчёт — список тест-файлов +
хвост `npm test` (сколько passed).

#### Отчёт Codex

Изменённые файлы:
- `frontend/package.json`, `frontend/package-lock.json` — dev-dependency `vitest` и скрипт `"test": "vitest run"`.
- `frontend/vitest.config.ts` — node environment и алиас `@/`; DOM-окружение не подключалось.
- `frontend/src/lib/format.test.ts` — `fmt.num/short/pct`, `sparkPath`, `sparkAreaPath`.
- `frontend/src/lib/posts.test.ts` — метрики/формулы, fallback-поля, media thumb/permalink, reactionsDetail и нулевой reach.
- `frontend/src/lib/period.test.ts` — все пресеты `tgLimit`, all-time/невалидные даты и точная временная граница.
- `frontend/src/lib/downsample.test.ts` — no-op режимы, длина threshold, сохранение первого/последнего элементов и subset исходных данных.
- `codex.md` — статус задачи и отчёт.

Хвост `npm test`:
```text
Test Files  4 passed (4)
     Tests  18 passed (18)
  Duration  2.36s
```

Хвост `npm run build`:
```text
✓ 121 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                  0.71 kB │ gzip:   0.39 kB
dist/assets/index-BVKWIWZm.css  22.41 kB │ gzip:   5.07 kB
dist/assets/index-DQ_GLdrT.js  377.89 kB │ gzip: 108.69 kB
✓ built in 4.59s
```

Решения/сомнения:
- Тесты используют только Vitest в `node` environment; `jsdom`, Testing Library, сеть и DOM не используются.
- `npm install` сообщил о 2 audit-находках в дереве зависимостей (1 moderate, 1 high); автоматический `npm audit fix --force` не запускался, чтобы не вносить несанкционированные breaking-обновления.
- Сомнений по тестовому покрытию заявленного скоупа нет.

**Ревью Claude — ✅ одобрено, замёржено в `main` (`a4da1ab`).** 4 файла, 18 тестов passed (прогнал
сам). Ассерты содержательные: формулы ERV/ER/virality + фоллбэки + thumb/permalink (`posts`),
граничные `tgLimit`/`inRangeByDays`, no-op/subset `lttb`, `fmt`/spark. audit-находки (1 moderate/
1 high в дереве deps) оставляем — `audit fix --force` не нужен (верное решение). **Отличная работа.**

---

### ✅ TASK-006 — Кликабельные графики: разворот в модалку + таймфрейм

**Зачем.** В легаси любой график можно было кликнуть → он открывался крупно в модалке, где можно
было менять таймфрейм (1М/3М/6М/1Г/Всё) независимо. Вернуть этот UX в новый апп.

**Прочитай в легаси `public/index.html`:** `addExpandButtons`, `chartFull` / `applyChartWindow`,
`CHART_MODAL_WINDOWS` (1М/3М/6М/1Г/Всё = 30/90/180/365/0).

**Что сделать (модалку — ПО ОБРАЗЦУ существующей `PostModal` в `src/panels/Posts.tsx`: fixed
inset-0, `bg-black/50`, центр-`Card`, закрытие по Esc / клику-вне / кнопке ×; БЕЗ Radix, без
нового дизайна):**
1. `src/components/ExpandableChart.tsx` — обёртка. Props:
   `{ title: string; children: ReactNode; renderExpanded?: (days: number) => ReactNode }`.
   - Оборачивает `children` в кликабельный контейнер (cursor-zoom + ненавязчивый «⤢»;
     помечай `{/* DESIGN: Claude review */}`). По клику → модалка с заголовком `title` и КРУПНЫМ
     графиком.
   - Если задан `renderExpanded` → в модалке сегмент-кнопки таймфрейма `1М/3М/6М/1Г/Всё`
     (дни 30/90/180/365/0; стили — как у `PeriodSwitcher` в `DashboardLayout`), локальный стейт
     `days` (дефолт 90), тело = `renderExpanded(days)`. Если `renderExpanded` нет → просто
     показать `children` крупнее.
2. Применить в панелях:
   - **История подписчиков** (`Charts.tsx`, `HistoryChartBlock`): обернуть в `ExpandableChart` с
     `renderExpanded(days)`, который берёт ПОЛНЫЙ архив `useHistory(730).rows`, режет последние
     `days` (0 = всё), прогоняет `lttbDownsample(…, 140, …)` и рисует `LineChart` (то же, но окно =
     `days`) — это даёт реальный независимый зум по архиву.
   - Остальные линейные/столбчатые графики (рост, взаимодействия, скорость, просмотры-по-дням,
     часы, дни недели, net-подписчики) — обернуть в `ExpandableChart` **без** `renderExpanded`
     (только крупный просмотр; их данные уже ограничены серверным окном/глобальным периодом).
   - Тепловую карту и Breakdown-списки НЕ оборачивать.
3. Переиспользуй `LineChart`, `lttbDownsample`, существующий modal-паттерн. Опц. (аккуратно): можно
   вынести общий `<Modal>` из `PostModal` и переиспользовать в обоих — но build должен остаться
   зелёным и поведение модалки поста не измениться.

**Не делать:** новый визуальный дизайн модалки/affordance (функц. минимум + DESIGN-маркер —
полирну сам); кастомный диапазон дат; не трогать тепловую карту/breakdown.

**Критерии приёмки:** `cd frontend && npm run build` зелёный; `npm test` зелёный (ничего не сломал);
клик по графику «История подписчиков» открывает модалку с рабочим таймфреймом (срез архива
пересчитывается при смене); клик по другим графикам открывает крупный вид; Esc/клик-вне/× закрывают.

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/components/ExpandableChart.tsx` — кликабельная обёртка с affordance `⤢`, модалка по паттерну `PostModal`, закрытие Esc/клик-вне/× и опциональные таймфреймы `1М/3М/6М/1Г/Всё`.
- `frontend/src/panels/Charts.tsx` — история подписчиков разворачивается с независимым окном по полному архиву `useHistory(730).rows`, повторным `lttbDownsample`; velocity разворачивается без re-window.
- `frontend/src/panels/TgAnalytics.tsx` — крупный просмотр для просмотров по дням, роста, взаимодействий, активности по часам, net-подписчиков и двух графиков дней недели.
- `codex.md` — статус задачи и отчёт.

Хвост `npm test`:
```text
Test Files  4 passed (4)
     Tests  18 passed (18)
  Duration  3.70s
```

Хвост `cd frontend && npm run build`:
```text
✓ 122 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                  0.71 kB │ gzip:   0.39 kB
dist/assets/index-DbcjN4VE.css  22.72 kB │ gzip:   5.15 kB
dist/assets/index-uAolFtU8.js  380.76 kB │ gzip: 109.29 kB
✓ built in 5.26s
```

Решения/сомнения:
- Для истории выбранное окно режет последние `days` строк полного архива (0 = всё), после чего данные заново downsample-ятся до 140 точек; дефолт модалки — 90 дней.
- Остальные перечисленные линейные/столбчатые графики используют исходный React-узел в модалке без дополнительного запроса или re-window.
- Heatmap, Breakdown-списки, Mentions и график внутри существующей `PostModal` не изменялись.
- Новый affordance помечен `{/* DESIGN: Claude review */}`; новых зависимостей и цветов нет.

**Ревью Claude — ✅ одобрено, замёржено в `main` (`03b584c`).** `ExpandableChart` корректен:
модалка по паттерну `PostModal` (Esc/клик-вне/×, без Radix), таймфрейм в стиле `PeriodSwitcher`,
превью доступен (role=button / Enter/Space / focus-ring / ⤢), DESIGN-маркер на месте. История
реально re-window'ится по полному архиву (`rows.slice(-days)` + LTTB, дефолт 90). Чистый `npm ci`
зелёный (vitest-3 сохранён — деплой не регрессирует), build + 18 тестов passed. **Отличная работа.**
Дизайн-полиш affordance/модалки — на мне (при общем проходе).

---

### ✅ TASK-007 — Tenant в React Query keys (+ отмена in-flight при свитче)

**Зачем.** Ключи каналозависимых запросов (`['tg-full', days]`, `['tg-stats']`, `['tg-graphs']`,
`['velocity']`, `['mentions']`, `['history-channel', days]`, `['post-stats', id]`) НЕ содержат
channelId. Канал — глобальная переменная (`lib/channel.ts`) + `invalidateQueries()` при свитче.
Риск (когда появится 2-й канал): медленный запрос канала A приходит после переключения на B и
пишется в общий ключ → данные A показываются как B; кэши каналов смешаны. Сейчас 1 канал —
эффекта нет, но фикс нужен ДО реального мультиканала.

**Что сделать:**
1. Сделать выбранный канал РЕАКТИВНЫМ через React-контекст (по образцу `PeriodProvider` в
   `lib/period.tsx`): `ChannelProvider` + `useSelectedChannel()` → `{ channelId: number | null,
   setChannelId }`. Провайдер обернуть вокруг `<App/>` в `main.tsx`.
   - `lib/channel.ts` (синхронный модульный стор, который читают `apiGet`/`apiSend` для заголовка
     `X-Channel-Id`) ОСТАВИТЬ. `setChannelId` обязан **синхронно** обновлять И модульный стор
     (`setSelectedChannel(id)`), И React-стейт — чтобы к моменту запуска queryFn заголовок уже был
     = новый канал.
   - Инициализация channelId — из поля `selected` ответа `/api/channels` (как сейчас в `ChannelSwitcher`).
2. Каналозависимые хуки в `queries.ts` читают `useSelectedChannel().channelId` ВНУТРИ и кладут его
   в queryKey ПЕРВЫМ полем: `['tg-full', channelId, days]`, `['tg-stats', channelId]`,
   `['tg-graphs', channelId]`, `['velocity', channelId]`, `['mentions', channelId]`,
   `['history-channel', channelId, days]`, `['post-stats', channelId, id]`.
   **Сигнатуры хуков для панелей НЕ меняй** (channelId берётся из контекста внутри хука) — панели
   не трогаем. НЕ-каналозависимые (`me`, `channels`, `admin-users`, `bugs`, `channel-keys`) — без
   изменений.
3. `ChannelSwitcher` (`DashboardLayout`) перевести на `useSelectedChannel()` (вместо локального
   useState + прямого `setSelectedChannel`). При смене: `setChannelId(id)` + опц.
   `queryClient.cancelQueries()` (отменить in-flight). Прежний безусловный `invalidateQueries()`
   при свитче убрать — смена channelId в ключах сама вызовет фетч нового канала, а данные прошлого
   останутся в своём кэш-слоте (быстрый возврат).
4. Поведение для 1 канала — не меняется.

**Критерии приёмки:** `npm run build` + `npm test` зелёные; каналозависимые queryKey содержат
channelId; запрос, стартовавший для канала A, при resolve пишется в ключ A (не в B); `X-Channel-Id`
в заголовке соответствует каналу на момент запроса; для 1 канала поведение прежнее.

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/lib/channel-context.tsx` — `ChannelProvider`/`useSelectedChannel`; `setChannelId` сначала синхронно обновляет существующий модульный store через `setSelectedChannel`, затем React state.
- `frontend/src/main.tsx` — `ChannelProvider` подключён внутри `QueryClientProvider` вокруг приложения.
- `frontend/src/api/queries.ts` — channelId добавлен в ключи `tg-full`, `tg-stats`, `tg-graphs`, `velocity`, `mentions`, `history-channel`, `post-stats`; сигнатуры хуков для панелей не менялись. Logout сбрасывает context и header-store.
- `frontend/src/components/DashboardLayout.tsx` — `ChannelSwitcher` переведён на контекст; глобальные `invalidateQueries()` удалены, при ручном переключении вызывается `cancelQueries()`.
- `codex.md` — статус задачи и отчёт.

Проверка:
```text
✓ 123 modules transformed.
✓ built in 4.89s

Test Files  4 passed (4)
     Tests  18 passed (18)
  Duration  3.82s
```

Решения/сомнения:
- Ключи имеют вид `['tg-full', channelId, days]`, `['history-channel', channelId, days]` и аналогично для остальных channel-dependent запросов; неканальные ключи оставлены прежними.
- Запрос канала A продолжает принадлежать ключу A даже после перехода на B; новый queryFn запускается после синхронного обновления `X-Channel-Id` store.
- Сброс channelId при logout предотвращает наследование tenant-контекста другим пользователем в той же вкладке.
- Для одного канала выбор по-прежнему инициализируется из `selected` ответа `/api/channels`.

**Ревью Claude — ✅ одобрено, замёржено в `main`.** `ChannelProvider`/`useSelectedChannel`
корректны: `setChannelId` синхронно обновляет модульный store (`setSelectedChannel`) ДО React-стейта,
поэтому к запуску queryFn заголовок `X-Channel-Id` уже = новый канал. channelId стоит ПЕРВЫМ полем
во всех channel-dependent ключах (`tg-full/tg-stats/tg-graphs/velocity/mentions/history-channel/
post-stats`); неканальные (`me/channels/admin/bugs/keys`) не тронуты. Свитч → `cancelQueries()`
(без глобального invalidate — данные канала остаются в своём слоте), logout сбрасывает channelId
(нет утечки tenant между юзерами в одной вкладке). `ChannelProvider` обёрнут вокруг `<App/>` внутри
`QueryClientProvider`. Прогнал сам: build 123 modules + 18 тестов зелёные. Для 1 канала поведение
прежнее. **Отличная работа.**

---

### ✅ TASK-008 — Dev-логирование дрейфа Zod-схем

**Зачем.** Схемы намеренно пермиссивные (`optional/nullable/passthrough`) — но при дрейфе API
парс может «тихо» пройти/упасть, и панель пустеет без явной диагностики. Нужна видимость в DEV.

**Что сделать (только `src/api/client.ts`, минимально):**
- В `apiGet` и `apiSend` заменить `schema.parse(data)` на `schema.safeParse(data)`:
  - при `!success`: в DEV (`import.meta.env.DEV`) → `console.warn('[api-drift]', method ?? 'GET',
    path, result.error.issues)` (видно путь поля + причину), затем бросить как сейчас (поведение
    не меняется — ошибка всплывает как `isError`; можно бросить `result.error`);
  - при `success` → вернуть `result.data`.
- В prod лишнего лога нет, поведение идентично текущему.

**Не делать:** не менять сами схемы; не глушить ошибки (всё ещё throw); без новых зависимостей.

**Критерии приёмки:** `npm run build` + `npm test` зелёные; при намеренно битом ответе в DEV в
консоли виден `[api-drift]` с путём поля; в остальном `apiGet`/`apiSend` ведут себя как прежде.

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/api/client.ts` — общий `parseResponse` использует `safeParse`; в DEV при ошибке пишет `console.warn('[api-drift]', method, path, issues)` и затем бросает исходный Zod error.
- `frontend/src/vite-env.d.ts` — стандартная декларация `vite/client` для типизации `import.meta.env.DEV`.
- `codex.md` — статус задачи и отчёт.

Проверка:
```text
✓ 123 modules transformed.
✓ built in 4.89s

Test Files  4 passed (4)
     Tests  18 passed (18)
  Duration  3.82s
```

Решения/сомнения:
- Для `apiGet` в лог передаётся `GET`, для `apiSend` — фактический method.
- В production предупреждение отсутствует; успешные ответы возвращают `result.data`, неуспешные по-прежнему приводят к throw/isError.
- Схемы и зависимости не изменялись.

**Ревью Claude — ✅ одобрено, замёржено в `main`.** `parseResponse(method, path, schema, data)`
через `safeParse`: в DEV (`import.meta.env.DEV`) → `console.warn('[api-drift]', method, path,
issues)` с путём поля, затем throw исходного Zod-error (поведение `isError` не изменилось); в prod
лог отсутствует, успех возвращает `result.data`. `apiGet` логирует `GET`, `apiSend` — фактический
метод. `vite-env.d.ts` добавил `vite/client` для типизации `import.meta.env`. Схемы/зависимости не
тронуты, build + тесты зелёные. **Отличная работа.**

---

## Навигация-редизайн (Variant 1) — бэклог Codex

> **Контекст.** Катовер 3F-3 B1 в проде: новый SPA на `/` (легаси на `/legacy`). Решён редизайн
> навигации — **Variant 1: левый сайдбар (виды) + переключатель платформ (TG, скоро IG/TikTok/
> Pinterest) + единый прокручиваемый «Обзор»**. **Дизайн-критичные части — за Claude:** сам шелл
> сайдбара (вёрстка/полировка), визуал account-style переключателя каналов, композиция
> прокручиваемого «Обзора». **Эти задачи — самодостаточные ЛОГИЧЕСКИЕ модули**, которые Claude
> вмонтирует в шелл. Не переверстывай `DashboardLayout` в сайдбар — это сделает Claude.
> 009 и 010 независимы (можно параллельно, каждая в своей ветке). 011/013 — после 009/010
> (общие файлы). Все правила выше в силе (без `any`, без `import React`, токены не хардкод-hex,
> не трогать `public/`/`/legacy`/CSP/`Dockerfile`, чистый `npm ci`+build зелёные).

### ✅ TASK-009 — Тёмная тема: провайдер + переключатель + персист

**Зачем.** Токены тёмной темы уже есть (`src/index.css` блок `.dark`: фон/текст/primary/border…),
но переключателя нет. Эталонные дашборды (Linear/Stripe/Vercel) дают свет/тьму. Нужен глобальный
тумблер, чтобы дашборд переключался применением класса `.dark` на `<html>`.

**Что сделать:**
1. `src/lib/theme.tsx`: `ThemeProvider` + `useTheme()` → `{ theme: 'light' | 'dark', toggle, setTheme }`.
   - Инициализация: `localStorage('pulse_theme')` если есть, иначе `matchMedia('(prefers-color-scheme: dark)')`.
   - Применение: тоггл класса `dark` на `document.documentElement` в `useEffect` при смене `theme`.
   - Персист: писать выбор в `localStorage` при `setTheme/toggle`.
2. `src/components/ThemeToggle.tsx`: минимальная кнопка-иконка (солнце/луна), зовёт `toggle`;
   функциональный минимум, пометка `{/* DESIGN: Claude review */}` (Claude переставит/оформит).
3. Обернуть `<ThemeProvider>` в `main.tsx` (вокруг `<App/>`, внутри `QueryClientProvider`).
4. Временно смонтировать `<ThemeToggle/>` в топбаре текущего `DashboardLayout` (одна строка +
   импорт, с DESIGN-маркером) — Claude перенесёт в шелл сайдбара. **Больше `DashboardLayout` не
   трогать** (не переверстывать).
5. Прогнать дашборд в тёмной теме глазами/по токенам: если встретишь захардкоженный цвет (hex/rgb)
   в компонентах нового аппа, который ломается в тёмной — заменить на семантик-токен
   (`bg-card`/`text-foreground`/`border`/бренд-`text-iris`…). Это design-light фикс, разрешён.
   `pages/Landing.tsx`/`pages/Auth.tsx` НЕ трогать (они намеренно всегда `.dark` через обёртку —
   вложенный `.dark` не ломается).

**Не делать:** не переверстывать `DashboardLayout` в сайдбар; не менять токены в `index.css`
(они уже есть); без новых зависимостей.

**Критерии приёмки:** `npm run build` + `npm test` зелёные; тумблер переключает свет/тьму, выбор
переживает рефреш (localStorage), первый визит уважает системную тему; в тёмной теме панели
читаемы (нет «белым по белому»).

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/lib/theme.tsx` — `ThemeProvider`/`useTheme`, системная тема по умолчанию, `pulse_theme` в localStorage, управление классом `.dark` на `<html>`.
- `frontend/src/components/ThemeToggle.tsx` — минимальная кнопка солнце/луна с DESIGN-маркером.
- `frontend/src/main.tsx` — `ThemeProvider` подключён внутри `QueryClientProvider`.
- `frontend/src/components/DashboardLayout.tsx` — временно смонтирован `ThemeToggle`, без перевёрстки shell.
- `codex.md` — статус задачи и отчёт.

Проверка:
```text
✓ 127 modules transformed.
✓ built in 7.89s

Test Files  4 passed (4)
     Tests  18 passed (18)
  Duration  1.64s
```

Решения/сомнения:
- Сохранённый `pulse_theme` имеет приоритет; при первом визите используется `prefers-color-scheme: dark`.
- `setTheme` и `toggle` сразу сохраняют выбор; эффект переключает класс `.dark` на `document.documentElement`.
- Аудит dashboard-кода не нашёл новых hex/rgb или `bg-white/text-black`; `bg-black/50` оставлен только у modal backdrop. Landing/Auth не менялись по условию.
- Автоматическая браузерная проверка локального dashboard была ограничена политикой локальной навигации среды; проводка проверена TypeScript/build и аудитом semantic tokens.

---

### ✅ TASK-010 — Skeleton-загрузка + пустые состояния панелей

**Зачем.** Сейчас в `isLoading`-ветках панелей просто текст «Загрузка…». Эталонные дашборды
показывают skeleton-плейсхолдеры (форму контента), а на пустых данных — осмысленное пустое
состояние. Это заметный полиш «по верхам».

**Что сделать:**
1. `src/components/ui/skeleton.tsx`: `<Skeleton className?>` — блок с `animate-pulse` и фоном на
   токене (`bg-muted`), скруглением. Бери дефолты из shadcn-skeleton (наш стек Tailwind3 это умеет).
2. Заменить текстовые `isLoading`-ветки в панелях на skeleton, повторяющий форму контента
   (карточки KPI → прямоугольники-карточки; график → широкий блок; списки → строки): `Hero`,
   `KpiGrid`, `Charts`, `Posts`, `Mentions`, `TgAnalytics`, `Hashtags`, `Digest`. Минимально и
   функционально; где новая раскладка skeleton — DESIGN-маркер.
3. Пустые состояния: где данных нет (пустой массив/нет канала), показать короткий нейтральный текст
   на `text-muted-foreground` (многие панели уже так делают — привести к единообразию, не выдумывать
   дизайн). `isError`-ветки НЕ менять.

**Не делать:** не трогать форматтеры/логику данных/queryKey; не трогать `DashboardLayout`/шелл;
без новых зависимостей (skeleton — свой компонент на Tailwind, без `@radix`/либ).

**Критерии приёмки:** `npm run build` + `npm test` зелёные; во время загрузки панели показывают
skeleton (видно при throttling/первом запросе), при пустых данных — аккуратный пустой текст;
`isError` без изменений.

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/components/ui/skeleton.tsx` — общий Tailwind Skeleton (`animate-pulse`, `bg-muted`, `rounded-md`).
- `frontend/src/App.tsx` — skeleton вместо текстовой загрузки auth guard.
- `frontend/src/panels/Hero.tsx` — добавлен отсутствовавший loading skeleton и нейтральное состояние без данных.
- `frontend/src/panels/KpiGrid.tsx`, `Charts.tsx`, `Posts.tsx`, `Mentions.tsx`, `TgAnalytics.tsx`, `Hashtags.tsx`, `Digest.tsx` — skeleton-плейсхолдеры формы контента на общем primitive.
- `frontend/src/panels/Admin.tsx`, `Bugs.tsx`, `Settings.tsx` — существующие дублированные pulse-блоки и текстовая загрузка ключей переведены на общий Skeleton.
- `codex.md` — статус задачи и отчёт.

Проверка:
```text
✓ 127 modules transformed.
✓ built in 7.89s

Test Files  4 passed (4)
     Tests  18 passed (18)
  Duration  1.64s
```

Решения/сомнения:
- Error-ветки не переписывались.
- Добавлены единообразные нейтральные empty states для Hero, истории подписчиков, TgAnalytics и Digest; существующие empty states остальных панелей сохранены.
- Поиск по `frontend/src` подтверждает: текстовых «Загрузка…» и локальных `animate-pulse` больше нет, анимация централизована в `Skeleton`.

---

### ✅ TASK-011 — Командная строка `⌘K` (без зависимостей)

**Зачем.** С ростом числа разделов и платформ главный апгрейд навигации эталонов (Linear/Vercel/
Stripe/Raycast) — палитра команд по `⌘K`/`Ctrl+K`: мгновенный переход к виду/каналу без кликов по
меню.

**Что сделать (БЕЗ новой зависимости — переиспользуй модал-паттерн `PostModal`/`ExpandableChart`:
`fixed inset-0`, `bg-black/50`, центр-`Card`, Esc/клик-вне/×):**
1. `src/components/CommandPalette.tsx` + хук `useCommandPalette()` (или внутренний стейт):
   глобальный слушатель `keydown` на `⌘K`/`Ctrl+K` (preventDefault) — открыть/закрыть; Esc — закрыть.
2. Содержимое: текстовый фильтр (autofocus) + список команд:
   - переходы по роутам (`useNavigate`): Обзор `/`, Аналитика `/analytics`, Графики `/charts`,
     Посты `/posts`, Упоминания `/mentions`, Настройки `/settings`, + Админ/Баги (показывать только
     для superuser — роль из `useMe()`);
   - смена канала из `useChannels()` (если каналов ≥2) — зовёт `useSelectedChannel().setChannelId`;
   - выход (`useLogout`).
   Фильтрация по подстроке (lowercase). Клавиши ↑/↓ двигают выделение, Enter — выполнить, мышь тоже.
3. Смонтировать `<CommandPalette/>` один раз (в `App.tsx` или в шелле). Функциональный минимум,
   DESIGN-маркер; Claude оформит.

**Не делать:** без новых npm-зависимостей (никакого `cmdk`); не дублировать данные — только хуки;
не трогать `DashboardLayout`-шелл (Claude интегрирует).

**Критерии приёмки:** `npm run build` + `npm test` зелёные; `⌘K`/`Ctrl+K` открывает палитру, фильтр
+ ↑/↓/Enter работают, переход к виду/смена канала/выход выполняются; Esc/клик-вне закрывают;
Админ/Баги-команды скрыты для не-superuser.

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/components/CommandPalette.tsx` — глобальный `⌘K`/`Ctrl+K`, фильтрация, клавиатурная
  навигация, переходы по роутам, смена канала и выход; Админ/Баги доступны только superuser.
- `frontend/src/App.tsx` — палитра смонтирована один раз рядом с защищённым layout.

Проверки:
- `npm run build`: успешно, 126 модулей, `✓ built in 2.55s`.
- `npm test`: успешно, 6 файлов / 26 тестов.

Решения/сомнения:
- `DashboardLayout` не менялся; палитра использует существующие `Card`, токены и модал-паттерн.
- Смена канала вызывает реактивный `setChannelId`; каналозависимые queryKey переключаются штатно.

---

### ✅ TASK-012 — `useScrollSpy` для прокручиваемого «Обзора»

**Зачем.** Единый «Обзор» (компонует Claude) — длинная прокручиваемая страница с секциями
(`КЛЮЧЕВЫЕ МЕТРИКИ`/`РОСТ`/`ТОП-ПОСТЫ`/…). Нужна подсветка текущей секции в боковой/секционной
навигации при скролле (как GA4/доки) — Claude вмонтирует, нужен сам механизм.

**Что сделать (тестируемо без jsdom — вынеси ЧИСТУЮ логику отдельно):**
1. `src/lib/scrollspy.ts`: чистая функция `pickActiveSection(entries: { id: string; top: number;
   ratio: number }[]): string | null` — выбирает активную секцию (напр. ближайшую сверху во вьюпорте /
   с макс. видимостью). Детерминированная, без DOM.
2. `src/lib/useScrollSpy.ts`: хук `useScrollSpy(ids: string[]): string | null` — `IntersectionObserver`
   на элементы `#id`, прокидывает наблюдаемые в `pickActiveSection`, отдаёт активный id. Хук — тонкая
   обёртка; вся логика выбора в чистой функции.
3. Тест `src/lib/scrollspy.test.ts` (vitest, node-env) на `pickActiveSection`: несколько секций →
   корректный активный id; граничные (пусто → null; одна секция; равные ratio — стабильный выбор).

**Не делать:** не добавлять jsdom/Testing Library (тестируем только чистую функцию); не строить саму
страницу «Обзора» (это Claude); без новых зависимостей.

**Критерии приёмки:** `npm run build` + `npm test` зелёные; новые тесты содержательны; хук
компилируется и экспортируется; чистая логика покрыта тестом.

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/lib/scrollspy.ts` — детерминированная чистая `pickActiveSection`.
- `frontend/src/lib/useScrollSpy.ts` — тонкая обёртка над `IntersectionObserver`.
- `frontend/src/lib/scrollspy.test.ts` — выбор по видимости, tie-break, пустые/скрытые/одиночные секции.

Проверки:
- `npm run build`: успешно.
- `npm test`: успешно; 3 новых scrollspy-теста, без jsdom/Testing Library.

Решения/сомнения:
- Приоритет — максимальная доля видимости; при равенстве выбирается ближайшая к верху секция,
  затем сохраняется исходный порядок.

---

### ✅ TASK-013 — KPI: дельта к прошлому периоду (честно, без выдумок)

**Зачем.** Карточки KPI сейчас показывают только число. Эталон (Stripe/Mixpanel) — число + дельта
к прошлому периоду (↑/↓ %). Это главный смысловой апгрейд карточек. Делать **только там, где данные
реально выводимы**; где нет — дельту НЕ показывать (никаких фейковых цифр).

**Что сделать:**
1. Хелпер (в `src/lib/posts.ts` или новый `src/lib/delta.ts`): `pctDelta(current, previous):
   { pct: number; dir: 'up' | 'down' | 'flat' } | null` (null если `previous` нет/0/невалид).
2. Подписчики: из `useHistory` взять значение на `now - days` (начало окна) vs последнее → дельта.
   Период берётся из `usePeriod()` (как в KpiGrid сейчас).
3. Пост-метрики (просмотры/реакции/репосты/ER): сравнивать сумму за ТЕКУЩЕЕ окно vs ПРЕДЫДУЩЕЕ окно,
   **используя только уже загруженные посты** (`useTgFull`). Если загруженный набор НЕ покрывает
   предыдущее окно (постов не хватает по дате) — вернуть `null` и дельту не рисовать. Без новых
   запросов/расширения лимитов.
4. В `panels/KpiGrid.tsx` отрисовать маленькую дельта-пилюлю рядом с числом (↑ зелёным /
   ↓ красным / flat — без пилюли), на семантик-токенах (`text-verdant`/`text-ember` или
   success/danger-токены). Функциональный минимум, DESIGN-маркер; спарклайн уже есть — не трогать.

**Не делать:** не выдумывать дельту при нехватке данных (null → нет пилюли); не добавлять
запросы/не менять лимиты/queryKey; без новых зависимостей.

**Критерии приёмки:** `npm run build` + `npm test` зелёные; где данные есть — корректная дельра
к прошлому периоду (знак/процент), где нет — пилюли нет; смена периода пересчитывает дельту.
Желательно мини-тест на `pctDelta` (граничные: previous=0/undefined → null).

#### Отчёт Codex

Изменённые файлы:
- `frontend/src/lib/delta.ts` — `pctDelta`, честное суммирование двух окон и дельта подписчиков.
- `frontend/src/lib/delta.test.ts` — направления/границы, покрытие предыдущего окна, история.
- `frontend/src/panels/KpiGrid.tsx` — дельты подписчиков, просмотров, реакций, репостов и ER.

Проверки:
- `npm run build`: успешно.
- `npm test`: успешно; 5 новых тестов дельт.

Решения/сомнения:
- Для периода «Всё», нулевой/невалидной базы и неполного покрытия предыдущего окна пилюля не
  отображается.
- Средний охват не получил дельту: задача перечисляет сравнимые пост-метрики, а карточка среднего
  требует отдельной договорённости о взвешивании.

**Ревью Claude — ✅ все пять одобрены, замёржены в `main` (две ветки: `codex/task-009` = 009+010,
`codex/task-011` = 011+012+013; merge + конфликт-резолв в `App.tsx`/`KpiGrid.tsx`/`codex.md`
сделал Claude).** Прогнал сам: чистый `npm ci` зелёный, `tsc --noEmit && vite build` (129 модулей),
`npm test` 26 passed (6 файлов; +delta +scrollspy). Локально засмоук-тест собранного бандла
(Express+dist): апп монтируется без console-ошибок, **тёмная тема проверена end-to-end** —
`ThemeProvider` уважает системный `prefers-color-scheme` И стор `pulse_theme` (light оверрайдит
системную тьму), `.dark` на `<html>` ставится/снимается. Командную палитру/KPI-дельты (видны только
залогиненным) проверял код-ревью + юнит-тесты — юзер досмотрит в проде.
- **009 (тёмная тема):** `lib/theme.tsx` корректен (localStorage→prefers-color-scheme, `.dark` на documentElement, персист); `ThemeToggle`/`Skeleton` на токенах, DESIGN-маркеры. Тумблер временно в топбаре `DashboardLayout` — Claude перенесёт в шелл сайдбара.
- **010 (skeleton+empty):** механическая замена inline-плейсхолдеров на `<Skeleton>` во всех панелях + аккуратные пустые состояния (Charts/Hero/Digest/TgAnalytics); `isError` не тронут.
- **011 (⌘K):** без зависимостей, на модал-паттерне; ⌘K/Esc, фильтр+↑/↓/Enter, маршруты (Админ/Баги gated by superuser) + смена канала (≥2) + выход; токены, без `any`.
- **012 (scrollspy):** чистая `pickActiveSection` (сорт ratio→|top|→index) + тест; хук на IntersectionObserver с guard. Потребитель («Обзор») — за Claude.
- **013 (KPI-дельты):** **честно** — `delta.ts` отдаёт `null` при нехватке данных (нет фейков); подписчики из истории, пост-метрики из текущего vs прошлого окна загруженных постов; `DeltaPill` на `text-verdant/ember`, DESIGN-маркер. Ср. охват без дельты — ок (осознанно). **Отличная работа по обеим веткам.**

---

### 🟢 TASK-014 — Пустое состояние для collector-канала без данных

**Зачем (реальный баг-репорт юзера 2026-06-26).** Юзер добавил 2-й канал (`@tydaaya`,
`source: 'collector'`). У collector-каналов данные приходят ТОЛЬКО от локального collector-агента
через `POST /api/collector/ingest`; пока агент не запущен — `/api/tg/full` отдаёт 200 с пустотой
(`channel: null`, `views_summary: null`, `posts: []`). Дашборд рисует это как стену нулей
(«0 / 0 / 0»), и юзер решил, что всё СЛОМАЛОСЬ. Нужно вместо нулей показать понятное пустое
состояние с next-step. (Центральный `@bynotem` `source: 'central'` — живые данные, его НЕ трогаем.)

**Что сделать (только новый компонент + ранний возврат в `panels/Hero.tsx` или общий слой «Обзора»;
без нового дизайна — на `Card`/токенах, DESIGN-маркер):**
1. Новый `src/components/CollectorEmptyState.tsx`: `Card` с заголовком
   `Канал @{username} подключён, но данные ещё не поступали`, телом-объяснением (collector-агент
   считает метрики у тебя локально и шлёт их сюда; пока он не запущен — данных нет) и двумя
   действиями-ссылками (react-router `Link`): **«Инструкция по подключению»** → `/connect`
   (роут добавит Claude — пока просто `Link to="/connect"`) и **«Открыть настройки / ключ»** →
   `/settings`. Функциональный минимум, `{/* DESIGN: Claude review */}`.
2. Логика показа (в «Обзоре» — там, где сейчас Hero+KpiGrid; см. `App.tsx` `Overview`): канал
   collector И пусто → показать `CollectorEmptyState` вместо Hero/KPI.
   - `source` канала: из `useChannels()` — найти канал по `useSelectedChannel().channelId`
     (`channels.find(c => c.id === channelId)?.source === 'collector'`).
   - «пусто»: из `useTgFull(days)` — `!data?.channel && (data?.posts?.length ?? 0) === 0`
     (не `isLoading` и не `isError` — только успешный пустой ответ).
   - Если канал central ИЛИ данные есть — поведение прежнее (Hero+KpiGrid).
3. НЕ дублируй стейт на каждой панели — достаточно перехвата на уровне «Обзора» (`Overview` в
   `App.tsx`). Остальные вкладки (Аналитика/Посты/…) оставь как есть (там уже есть свои пустые
   состояния из TASK-010).

**Не делать:** не трогать central-ветку/`@bynotem`; не менять схемы/queryKey; не делать сам
`/connect` (его содержимое+роут — Claude); без новых зависимостей.

**Критерии приёмки:** `npm run build` + `npm test` зелёные; при выборе collector-канала с пустым
ответом «Обзор» показывает понятное пустое состояние с 2 ссылками (а не нули); central-канал и
collector-канал С данными показывают обычный дашборд; loading/error не регрессируют.

#### Отчёт Codex

**Выполнено:** 2026-06-26  
**Ветка:** `codex/task-014` (коммит 10c8448)  
**Файлы:**
- создан: `frontend/src/components/CollectorEmptyState.tsx`
- изменён: `frontend/src/App.tsx` (добавлены 4 импорта; `Overview` расширен логикой пустого состояния)

**Сборка:** `npm run build` → ✅ зелёная (tsc --noEmit + vite build, 131 модуль)  
**Тесты:** `npm test` → ✅ зелёные (26 тестов / 6 файлов)

**Решения:**
- Хуки: `useTgFull` и `useChannels` в `@/api/queries`, `usePeriod` в `@/lib/period`.
- Поле username: `Channel.username` (nullable string) — `channel?.username ?? ''`.
- Пустота проверяется только при !isLoading && !isError, чтобы не скрывать ошибки.
- CRLF-файл: замены сделаны CRLF-совместимо.
- Ветка `codex/task-014` создана локально, в main не смерджена.

**Ревью Claude — ✅ одобрено, замёржено в `main` (FF, первая задача через прямой Codex-CLI-runtime, не релей).** `CollectorEmptyState` на семантик-токенах (`bg-card/text-foreground/text-muted-foreground/text-primary/border`, без hex), DESIGN-маркер, 2 `Link` на `/connect` и `/settings`. `Overview` корректно гейтит: `isCollector` (по `source` выбранного канала) И `isEmpty` (`!data?.channel && posts===0`) ТОЛЬКО при `!isLoading && !isError` — central и collector-с-данными не затронуты. Прогнал сам: build 131 модуль + 26 тестов зелёные. Мелочь на потом (мой дизайн-полиш): при пустом `username` рендерится «Канал @ …» — добавлю фоллбэк. **Отличная работа, прямой runtime сработал.**

---

### 🟢 TASK-015 — Collector: QR-логин + локальная сессия (убрать ручную StringSession и 2FA-боль)

**Зачем.** Самый болезненный шаг онбординга collector-канала — получить `TG_SESSION` вручную
(телефон → код → **пароль 2FA**) и скопировать строку в `.env`. Решение (как мы уже делали в другом
проекте): **QR-логин**. Агент показывает QR, юзер сканирует в Telegram-приложении, 2FA-пароль
вводится ОДИН раз, сессия сохраняется ЛОКАЛЬНО — юзер больше не трогает строку сессии. Это
Python-часть (агент); упаковку в exe/прелоад api_id и фронт-флоу делает Claude отдельно.

**Контекст кода:** `collector/pulse_collector.py` использует `from mtproto import service` →
`service.get_client()` строит `TelegramClient(StringSession(SESSION), API_ID, API_HASH)` где
`SESSION = os.getenv('TG_SESSION')` (читается на ИМПОРТЕ `mtproto/service.py`, ~стр.26-36). Значит
сохранённую сессию надо положить в `os.environ['TG_SESSION']` ДО первого `from mtproto import service`.
Telethon уже в зависимостях. api_id/api_hash — пока из env как сейчас (встроенный дефолт для
прелоада добавит Claude на этапе сборки; в этой задаче НЕ хардкодь никаких api_id/api_hash и не
коммить секреты).

**Что сделать:**
1. **Новая команда `login`** (добавь в `choices` argparse и в диспетчер `async_main`):
   - Построй `TelegramClient(StringSession(), api_id, api_hash)` напрямую (Telethon), `await connect()`.
   - Если `await client.is_user_authorized()` → сразу сохрани сессию и выйди (идемпотентно).
   - Иначе QR-логин:
     ```python
     qr = await client.qr_login()
     while True:
         render_qr(qr.url)                      # ASCII-QR в терминал (см. п.3)
         print('Открой Telegram → Настройки → Устройства → Подключить устройство, наведи камеру')
         try:
             await qr.wait(timeout=30)
             break
         except asyncio.TimeoutError:
             await qr.recreate(); continue       # токен протух — новый QR
         except SessionPasswordNeededError:
             from getpass import getpass
             await client.sign_in(password=getpass('Пароль двухэтапной аутентификации: '))
             break
     ```
     (`SessionPasswordNeededError` из `telethon.errors`.)
   - Сохрани `client.session.save()` (StringSession-строка) в `state_directory()/session.txt`
     (права 600, `state_directory()` уже есть). `print('Готово — сессия сохранена, можно запускать once/run.')`
   - `await client.disconnect()` в finally.
2. **Загрузка сохранённой сессии при старте** `async_main`: если `os.getenv('TG_SESSION')` пуст,
   а `state_directory()/session.txt` существует → прочитать и `os.environ['TG_SESSION'] = saved`
   **ДО** любого вызова, который импортирует `mtproto.service`. Сделай это в начале `async_main`
   (или в `validate_config`), но именно до `doctor/once/run`-веток.
3. **`TG_SESSION` больше не обязателен** в `validate_config`: убери его из `required` для
   telegram-веток (сессия теперь приходит из `login`/файла). Если после загрузки файла сессии всё
   ещё нет и команда не `login` → понятная ошибка: «Нет сессии — запусти `login` (покажет QR)».
4. **ASCII-QR**: добавь зависимость `qrcode` (чистый Python, без PIL для ASCII). `render_qr(url)`:
   `import qrcode; q=qrcode.QRCode(border=1); q.add_data(url); q.make(); q.print_ascii(invert=True)`.
   Добавь `qrcode` в `collector/requirements.txt` (создай, если нет: `telethon` + `qrcode`).
5. **README + `--help`**: добавь `login` в `collector/README.md` (новый рекомендованный первый шаг
   вместо ручной строки сессии); пометь, что `TG_SESSION` теперь опционален.

**Не делать:** не хардкодь/не коммить api_id/api_hash или секреты; не трогай фронт; не делай
упаковку в exe (Claude); не меняй формат ingest/схему; managed-режим (серверная сессия) — НЕ сейчас.

**Критерии приёмки:** `python collector/pulse_collector.py login` показывает ASCII-QR, по скану
авторизуется (с разовым вводом 2FA-пароля, если включён) и пишет `session.txt`; последующие
`doctor`/`once`/`run` работают БЕЗ `TG_SESSION` в env (берут сессию из файла); `TG_SESSION` в env
по-прежнему уважается (приоритет над файлом — не обязателен); `flush` (без telegram) не сломан;
`python -c "import ast,sys; ast.parse(open('collector/pulse_collector.py').read())"` ок. В отчёт —
как проверял (хотя бы парс + ручной прогон `login`, если есть тестовый аккаунт).

#### Отчёт Codex
_(пусто — заполнит Codex)_
