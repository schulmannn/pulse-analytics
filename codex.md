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
- Не вводи новые npm-зависимости без явного разрешения в задаче.

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

### 🟢 TASK-003 — Глобальный период-фильтр (7 / 30 / 90 / 365 / Всё)

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
_(пусто — заполнит Codex)_

---

### ⏸ TASK-004 — Мультиканал: инвалидация при первичной установке канала

**Зачем.** В `ChannelSwitcher` (`DashboardLayout`, из TASK-001) при ПЕРВИЧНОЙ авто-установке
канала (`useEffect`) нет инвалидации кэша. Для ≥2 каналов, если серверный дефолт ≠ `channels[0]`,
первый рендер покажет данные дефолтного канала до ручной смены.

**Что сделать:** в init-эффекте `ChannelSwitcher` после `setSelectedChannel(initial)` вызвать
`queryClient.invalidateQueries()` — **только при `channels.length >= 2`** (для 1 канала дефолт-
резолюция корректна, лишний рефетч не нужен). Не создать цикл ре-рендеров / рефетч-шторм.

**Критерии приёмки:** build зелёный; для 1 канала поведение и число рефетчей не меняются;
для ≥2 каналов первичный выбор инвалидирует кэш ровно один раз.

_(активировать после ревью TASK-003)_
