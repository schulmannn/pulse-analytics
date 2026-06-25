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

### 🟢 TASK-001 — Channel switcher + `X-Channel-Id` (мультитенантность)

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
_(пусто — заполнит Codex: список изменённых файлов, хвост `npm run build`, решения/сомнения)_

---

### ⏸ TASK-002 — Auth в новом аппе (ЛОГИКА; дизайн форм/лендинга — за Claude)

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

_(активируется после ревью TASK-001)_
