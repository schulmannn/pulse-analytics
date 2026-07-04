# METRIC_BUILDER_SPRINTS — трекер трека «конструктор метрик» (Steep-parity)

Source of truth для этого трека. План: `STEEP_METRIC_BUILDER.md`. Статусы: TODO / WIP / SHIPPED `<commit>`.

Гейт каждой задачи (перед пушем): `npm --prefix frontend run build` + `npm --prefix frontend run test`
(было 152 теста) + adversarial-само-ревью. Server — `node --check` + server-тесты. Git: add только свои
файлы, bundle-hash poll после push.

## Спринты

- **S1 — Каталог метрик `lib/widgetMetrics.ts`** — SHIPPED `8863cac`
  Единый `MetricDef[]` (id/label/source/kind/unit/defaultViz/supportedViz/dimensions/category/seriesAgg/
  drillKey + тексты «О метрике») поверх metricDefs + kpiDerive DrillKey + TgAnalytics derived + IG
  (igMetrics). React-free + 12 unit-тестов (163 всего). 22 TG + 11 IG метрик; `define()` factory
  заполняет viz по kind. Ничего в рендере не трогает (tree-shaken → бандл не изменился, прод-верифай
  не нужен). Ключевые экспорты для S2-S6: `WIDGET_METRICS`, `METRIC_BY_ID`, `getMetric`, `isMetricId`,
  `metricsForSource`, `CATEGORY_LABEL/ORDER`.
- **S2 — Модель `WidgetConfig` `lib/widgetConfig.ts`** — SHIPPED `0a6c8b8`
  React-free `WidgetConfig {id,metricId,viz,title?,period?,grain?,includeToday?,source?,size?,filters?,
  comparison?,target?,style?}` + богатые под-типы (Comparison S8 / Target S9 / Filter S7) СРАЗУ по
  спеке, чтобы поздние спринты не переформировали данные. `normalizeWidget/normalizeWidgets` (валидация/
  коэрсия, НИКОГДА не бросает: unknown metricId→drop, unsupported viz→defaultViz), `defaultWidget(id)`,
  custom-key хелперы (`custom:<id>` для Home/report слотов). Переиспользует `genId` (reportBlocks),
  `getMetric/isMetricId/WidgetViz` (S1). 23 unit-теста (185 всего). Tree-shaken → прод не меняется.
  Store/sync (localStorage+/api/prefs) отложен до S4 (когда рендерер будет потреблять конфиги).
- **S3 — Единый резолвер `lib/resolveWidgetMetric.ts`** — WIP (S3a `7386ba5` + S3b `6a41b82` SHIPPED)
  `resolveWidgetMetric(config, ctx): WidgetResult`. **S3a:** ядро — 6 core TG как value+delta+caption
  (`deriveKpis`) + grain-series + ghost (`comparisonWindow`/`alignGhost`); erv/virality как value.
  `DataContext` = pre-resolved окно (`now/days/range/inRange`) + payloads → pure/детерминирован. Series
  = raw bucket keys. Никогда не бросает (`empty:true`). **S3b:** TG breakdown (emoji/formatPerf/weekday/
  postCount/engagementComposition/viewsByType/viewsBySource/newFollowersBySource/languages/sentiment/
  hours/churn) через новый pure `lib/tgAggregations.ts` (порт агрегаторов из TgAnalytics, БЕЗ трогания
  живой страницы — миграция самой TgAnalytics → S12). +graphs в DataContext. all-zero breakdown = empty.
  **Резолвер покрывает 20 метрик.** 19 тестов (204 всего). **S3c (SHIPPED `b9cfad8`):** netGrowth (series-из-graphs.followers,
  net daily=joined−left, flow-бакет+окно; guard data-aware `inWin.length===0`, не мёртвый — урок из
  S11); tables (weeklyTable/topPosts) НЕ в story-card билдере — каталог скрывает kind==='table' (богатая
  таблица не для тайла; живут в Отчётах). +2 теста (246). **Резолвер закрывает все addable-метрики.**
- **S4 — Единый рендерер + story-card `components/WidgetRenderer.tsx`** — SHIPPED `1205b65`
  `WidgetRenderer({result, viz})` = story-card ТЕЛО (hero value → DeltaPill → caption → chart);
  читает ТОЛЬКО WidgetResult (не знает TG/IG). viz→primitive: line/bar (LineChart/BarChart+ghost),
  donut (PieChart), list (Breakdown), kpi (hero+спарклайн). Pure-логика в `lib/widgetRender.ts`
  (bucketLabel/unitFormat/seriesToChart/breakdownTitles/`effectiveViz` graceful-fallback) — 10 тестов
  (214 всего). Charts берут высоту из ExpandedChartHeightContext карточки. Tree-shaken до монтирования
  (S6). rank/pivot/table → fallback на data-shape (не рендерятся из WidgetResult).
  **⚠️ Порядок S5↔S6:** S5-редактор оперирует WidgetConfig, которых нет на surface до S6-монтирования
  → делаю S6 (каталог+store+mount) ПЕРЕД S5 (богатый редактор).
- **S5 — Универсальный Widget Editor `components/ConfigEditDialog.tsx`** — SHIPPED `8971407`
  Отдельный редактор, пишущий в WidgetConfig (не в prefs): Визуализация (по supportedViz) · Период ·
  Грануляция (series) · Сравнение (series) · Целевой уровень (series) · Источник · Заголовок · Размер ·
  Акцент · Цветной фон. ChartSection получил аддитивный проп `configEditor {open,color,tinted,size,
  target}` — config-виджет открывает ЭТОТ диалог (legacy подавлен `&& !configEditor`), а accent/tint/
  size/target карточки берутся из config; нормальные prefs-виджеты не задеты (инвариант проверен).
  **Adversarial-review воркфлоу (10 агентов, 5 осей→verify): 2 реальных дефекта пойманы+пофикшены** —
  (1) config.target не был прокинут в WidgetTargetContext (оба provider-сайта→`activeTarget`; ConfigWidget
  прокидывает fixed-goal); (2) Сравнение/Цель показывались для value-метрик без эффекта → gated на series
  (ghost/goal-линия рендерятся только на графике). 3 находки отклонены (adversarial, одна — live Chromium).
  Filter→S7, dynamic/forecast target + KPI-прогресс→S9. Гейт build+224.
- **S6 — Add-widget catalog + mount (делаю ПЕРЕД S5)** — WIP (S6.1 SHIPPED `508acda`)
  **S6.1 (done):** `lib/widgetStore.ts` — localStorage-first + pub-sub стор для `WidgetConfig[]`
  (get/set/add/addForMetric/update/remove + `useWidgetConfigs` hook). Всё через `normalizeWidgets`
  (корраптнутый blob → []). Стабильный snapshot-кеш для useSyncExternalStore (иначе loop). Account-
  sync (/api/prefs) — осознанный follow-up (device-local first, нулевой риск текущему prefs-sync).
  10 тестов со стабом (224 всего). **S6.2 (done `880205b`):** bridge-hook `lib/useWidgetData.ts`
  (собирает DataContext из useTgFull{windowPair}/useHistory/useTgGraphs/useChannels+config.period+
  channel → resolveWidgetMetric, memo) + `components/ConfigWidget.tsx` (ChartSection-chrome + WidgetRenderer,
  ChannelScope при config.source). Typecheck-verified, tree-shaken. **S6.3 (SHIPPED `54ba3c6`, ПЕРВЫЙ ВИДИМЫЙ):**
  `WidgetCatalogModal` (поиск + группы CATEGORY + карточки метрик с formula/recommended-viz) +
  монтирование на Home: `known` принимает `custom:<id>`, ветка рендера → `ConfigWidget`, `useWidgetConfigs`
  подписка, AddWidgetBar → «Метрика из каталога…» (addWidgetForMetric → pinToHome(customKey)). Legacy-
  пресеты сохранены («Готовые виджеты»). **IG скрыт в каталоге до S11** (резолвит empty). **ПЕРВЫЙ
  коммит, меняющий бандл** — registry-путь байт-идентичен (обёрнут в else). Гейт build+224. ⚠️ Живой
  визуал = юзер на проде (authed Home локально не рендерится). Rich-редактор config (period/grain/
  comparison/target/filter) = S5; сейчас ⋯Изменить правит только prefs (title/color/size) — переходно.
- **S7 — Per-widget фильтры `FilterBuilder` + каталог DIMENSIONS** — SHIPPED `1b3c8ac`
  `lib/dimensions.ts` — каталог измерений (tg.format/tg.weekday) + `postMatchesFilters(rawPost,filters)`
  (pure предикат на raw TgPost; AND; unknown dim→pass; undated→fail-in/pass-not_in). Резолвер:
  `applyFilters` фильтрует full.posts ДО deriveKpis (core: value/delta/series/normPosts согласованы) +
  resolveTgBreakdown фильтрует post-derived (emoji/formatPerf/weekday/postCount). Graphs/summary —
  агрегаты без per-post, фильтр не применяется (редактор не предлагает). Каталог: dimensions на
  post-derived breakdowns. Редактор: FilterBuilder (per-dim Вкл/Искл + чипы значений). Этап 1 =
  клиентская фильтрация загруженных постов. +13 тестов (259). **Adversarial-review (3 агента): 1 дефект
  [HIGH]** — delta-pill core-KPI (views/reactions/forwards) показывал ВЕСЬ канал (архивный тренд) рядом
  с отфильтрованным value → фикс: recompute из filtered `windowTotals` ИЛИ suppress (null) при отсутствии
  парного post-окна (avgReach уже post-derived, не трогаю); заперт детерминированным тестом.
- **S8 — Сравнение как настройка модели** — SHIPPED `f426b96`
  `comparisonBaseline(cmp, winFrom, winTo)` — previous_period/year (metricSeries) + **same_period_last_month**
  (−30д shift) + **custom** (explicit from/to). `wantsGhostLine` соблюдает `display`: **«Дельта» больше не
  рисует ghost-линию** (был мёртвый контрол). ghostLabel per mode. Применено к TG field+subscribers.
  **IG-сравнение оживлено:** `applyIgGhost` (baseline-серия из сдвинутого IG-окна, aligned) в flowSeries
  (reach/interactions)+netFollowers — раньше редактор показывал контрол для IG series, а резолвер игнорил.
  +4 теста (263). **Adversarial-review (4 агента): 2 дефекта [LOW] пойманы+пофикшены** — (1) netFollowers
  ghost глотался при genuine net-zero baseline → gate по baseline `hasCur` (allowZero), reach/interactions
  сохраняют `!==0`; (2) same_period_last_month fixed-30d ломал выравнивание при календарном grain → grain-
  aware сдвиг (`shiftMonthsUTC` для month/quarter/year, 30д для day/week) + режим добавлен в редактор.
  Примечание: 'ghost_line'≈'both' визуально (pill=hero-delta всегда).
- **S9 — Target / forecast** — SHIPPED `e52ff2b`
  Target стал resolver-owned: `resolveWidgetMetric` = wrapper над `resolveMetricCore` + `resolveTargetValue`
  (fixed→value; **dynamic**→valueRaw другой same-source метрики через рекурсивный core-resolve, self-guard;
  forecast отложен — семантика фуззи). `result.target`+`result.targetPct`. WidgetRenderer: goal-линия из
  `WidgetTargetContext=result.target` + **«N% от цели»** (steep-подпись). ConfigWidget убрал configEditor.
  target. Редактор: TargetField (Нет/Число/Метрика + пикер метрики). +4 теста (267). Adversarial-review.
- **S10 — Богаче grain (day..year, flow vs level)** — SHIPPED `1d308a9`
  `SeriesGrain = Grain | quarter | year` в metricSeries (Grain=day/week/month оставлен для MetricPage
  Record-мап — живую страницу НЕ трогал; функции расширены до SeriesGrain, Grain остаётся assignable).
  bucketKeyOf → `YYYY-Qn`/`YYYY`; bucketKeysInWindow — календарный обход month/quarter/year. Резолвер
  effGrain пропускает quarter/year; flow (bucketPostField) СУММА, level (bucketSubsLevel) ПОСЛЕДНЕЕ —
  инвариант заперт тестом (quarter-сумма views=3500, year-level subs=44000, не сумма). bucketLabel
  «n кв. YYYY»/год. Редактор +Квартал/Год. +8 тестов (232). Adversarial-review boundary+integration.
- **S11 — IG-пути в резолвере + раскрытие IG в каталоге** — SHIPPED `a64a29d`
  `lib/igAggregations.ts` (pure IG-порт: igSeriesPoints с history-lengthen reach/follower, netFollower
  points, bucketIgSeries flow-сумма, igWindowValue, breakdowns formats/age/gender/countries/cities/hours
  — переиспользует igMetrics + metricSeries). Резолвер: `DataContext.ig` = IgDataContext, `resolveIg`
  выводит IG-окно ТОЧНО как useIgData (until/since, 90-cap) → reach/interactions/netFollowers/followers/
  erv + breakdowns. `lib/useIgWidgetData.ts` (IG query-хуки→ctx.ig). ConfigWidget = диспетч TG/IG
  **компонентами** (не условный хук → TG-виджет не монтит IG-запросы). Каталог: IG раскрыт
  (AVAILABLE_SOURCES=['tg','ig']). **Резолвер покрывает 31 метрику (20 TG + 11 IG).** +12 IG-тестов
  (244) с точными значениями. **Adversarial-review (5 агентов, 3 оси): 2 дефекта пойманы+пофикшены** —
  (1) [HIGH] ig.netFollowers мёртвый guard (`series.length===0` не срабатывает т.к. bucketKeysInWindow
  всегда ≥1) → при insights=undefined «0» вместо empty; фикс через `hasCur` из igWindowValue (наивный
  фикс сломал бы реальный net-zero — верификатор поймал); (2) [LOW] igFormats терял format-stable цвет
  `MEDIA_PRODUCT_CHART` → фикс. **Живой e2e IG = юзер (IG-подключённый канал).**
  Осталось: SourceField не даёт пинить IG-канал для IG-виджета (follow-switcher ок; follow-up).
- **S12 — Визуальный слой ПОСЛЕ модели** — SHIPPED `8f39ed6` (полировка; миграция TgAnalytics отложена)
  Story-card полировка из ОДНОГО рендерера: **компактный статистика-футер** (Макс · Среднее) под series-
  графиком (`seriesStats` pure+тест) — «ledger»-плотность (steep: линия читается и числами). Hairline,
  2 начертания, без теней/градиентов (governance). +2 теста (269). **Осознанно НЕ сделано:** tonal-фоны
  по category (конфликт с design-governance «без градиентов»); единый tooltip (у чартов уже есть).
  **⚠️ Миграция TgAnalytics на резолвер/рендерер ОТЛОЖЕНА** — большой live-refactor страницы, локально
  не верифицируется (нет authed-рендера); панель уже работает на inline-логике (агрегаторы уже в lib).

## Пост-план: унификация системы виджетов (фидбек юзера 2026-07-03)

Цель: стереть грань legacy/metric-виджетов, universal explorer, create-preview, curated Home. Порядок:
- **U1 — Responsive height bug** — SHIPPED `37a1f21`. Корень: `SIZE_H` third/half был `lg:h-[264px]` →
  ниже lg карточка content-height, тело flex-1 измеряется и кормит высоту чарта (контент SVG+легенда >
  высоты) → петля без границы → десятки тысяч px ~900px. Фикс: фикс-высота на ВСЕХ breakpoint + cap
  измерения (>640→null) + `min-w-0` на grid-элемент. Визуал=прод (900/1280/1440).
- **U2 — Create-widget preview** — SHIPPED `13a6277`. Извлёк `WidgetConfigControls` (общий edit+create).
  `CreateWidgetDialog`: живой preview (`WidgetBody` над draft, real data, ChannelScope по source) + те же
  контролы + «Добавить на главную». Home: каталог→create-step (не мгновенный add). `WidgetBody` экспортнут.
- **U3 — Universal explorer** — SHIPPED `bba9774`. `WidgetExplorer` = полноэкранная ПЕСОЧНИЦА: большой
  чарт (full axes, ChartExpandedContext=true, h420) над ЛОКАЛЬНЫМ draft + `WidgetConfigControls` справа;
  «Применить к виджету» коммитит (updateWidgetConfig), иначе виджет не тронут. Подключено через новый
  аддитивный проп `explorer` в ChartSection (config-виджет передаёт песочницу; legacy не задет → старый
  ChartExpandOverlay). Ноль per-chart explorer-кода — работает для любого config-виджета.
- **U4 — recommendedSize + авто-размер** — SHIPPED `c32badb`. `recommendedSize(metric)` в widgetMetrics
  (value→third, donut→third, table→full, else half); `defaultWidget` сидит size → свежий виджет и create-
  preview стартуют с разумным размером, не всегда half.
- **U5 — убрать нерендерящиеся viz** — SHIPPED `c32badb`. `vizForKind` series больше не отдаёт rank/pivot
  (резолвер не производит их форму, рендерер не рисует) → редактор предлагает только line/bar. Table-kind
  уже скрыт из каталога (S3c). Тесты обновлены.
- **U6 — legacy как config-виджеты** (юзер выбрал полный adapter-рефактор). Стадии:
  - **U6.1 (модель) SHIPPED `6114c83`:** `lib/legacyWidgets.ts` (pure) — LEGACY_KEYS/LABEL/CAPABILITIES +
    `legacy:<key>` metricId-неймспейс. `normalizeWidget` принимает legacy-конфиги (viz='kpi' sentinel,
    shell-поля валидируются). `legacyWidgetConfig(key)`. +3 теста.
  - **U6.2 (унификация редактора) SHIPPED `6114c83`:** `lib/widgetCapabilities.ts` — `editorSpec(config)`
    (metric→из MetricDef, legacy→из adapter). `WidgetConfigControls` теперь на `spec`+capabilities-гейт
    (не metric.kind). ConfigEditDialog/CreateWidgetDialog/WidgetExplorer больше не требуют MetricDef →
    работают и для legacy. +5 тестов (278). Composite legacy = shell-only (period/source/title/size/style).
  - **U6.3a (4 bare-блока как config) SHIPPED `57fcf0a`:** `components/legacyAdapters.tsx`
    (`LEGACY_RENDER` bare-тела kpi/digest/growth/top-posts + `isWiredLegacyKey`) + ConfigWidget
    `WidgetBody`→`LegacyWidgetBody` (adapter в `WidgetPeriodProvider(config.period)`, recency-widen +
    widen-нота) + editor/explorer ungate (`metric || legacyKey`). Home рендерит wired-legacy через
    ConfigWidget; own-chrome (history/velocity/heatmap/mentions) пока на HOME_REGISTRY (→U6.3b).
    **ДЕВИАЦИЯ от «переписать pinned на custom:<id>»:** bare-ключ ОСТАЁТСЯ в account-synced pinned-
    списке (стабильный cross-device pointer); per-instance config — device-local с ДЕТЕРМИНИРОВАННЫМ id
    `legacy-<key>` (`legacyConfigId`), heal-per-device. Деструктивный rewrite отвергнут (cross-device
    blank-Home). **Миграция (adversarial-review поймал 6 confirmed):** `home-<key>` prefs → новый config
    identity `custom-legacy-<key>` — `healedLegacyConfig`/`legacyConfigSeed` (period/size/title/source/
    accent), `hidden`→`setWidgetHidden(newId)`, reorder-слот→`remapGroupOrder`; иначе сбрасывались все
    настройки + pinned source (HIGH: чужой канал/wrong-data). Эффект = one-time seam (guard
    `!getWidgetConfig`, keyed pinnedSig), idempotent (verify-агент подтвердил). +5 тестов (283).
    Экспортнуто из ChartWidget: `getWidgetPrefs/setWidgetHidden/remapGroupOrder/PERIOD_WORD/WidgetPrefs`.
  - **U6.3b (own-chrome 4 блока) — ОСОЗНАННО ОТЛОЖЕН (не делать как adapter-экстракцию):** history/
    velocity/heatmap/mentions рендерят СВОЙ ChartSection с богатыми `variants` (bar/line switcher) +
    Tier-2 `expand` (anomaly/extreme-marked overlay). Shell-only config-модель их бы ДЕГРАДИРОВАЛА
    (потеря switcher'а + rich-expand) ради маргинальной унификации. Плюс дублируют каталог-метрики
    («История подписчиков» ≈ `tg.subscribers`, heatmap ≈ breakdown). Работают на Home через HOME_REGISTRY.
    Правильный путь (если делать) = превратить в НАСТОЯЩИЕ каталог-метрики с resolver-поддержкой (большая
    работа), НЕ shell-adapter. Оставлены на registry-пути намеренно. **Метрик-билдер трек = ЗАКРЫТ.**
Риск снят юзером («никто не пользуется»); гейт=build+тесты+review, визуал=прод.

## Prod-review фидбек юзера 2026-07-04 — переприоритезация бэклога (ГЛАВНОЕ)

Юзер прогнал прод-ревью (ultrareview-worktree). Вывод: «premium» упирается НЕ в ещё один цвет/border, а
в КОНСИСТЕНТНОСТЬ МОДЕЛИ — любой виджет = одна сущность, синкается как часть аккаунта, открывается в один
и тот же explorer, честно объясняет источник/качество данных. Новый порядок приоритетов (сверху = раньше):

**P0 (сначала):**
- **Account-synced WidgetConfig store.** `lib/widgetStore.ts` сейчас localStorage-only (account-sync
  осознанно отложен с S6.1). Для premium слабо: настройки виджетов/источников/цветов не переезжают между
  устройствами. Чинить: hydrate/persist через `/api/prefs` или отдельный `/api/widget-configs`; хранить
  `WidgetConfig[]` c `updatedAt`/`schemaVersion`; merge local+server; только потом Home = «истина».
- **IG-редактор показывает TG-источники (BUG, подтверждён на проде).** IG → «Охват» → поле «Источник»
  показывало TG-каналы (bynotem/tydaaya). Корень: `ConfigEditDialog.tsx` SourceField фильтрует
  `c.source !== 'ig'` (показывает НЕ-ig). Чинить: source-aware по `getMetric(config.metricId)?.source` —
  IG-метрика → только ig-каналы, TG → только tg; если IG не подключён → disabled empty-state, НЕ чужие каналы.

**P1:**
- **Universal explorer parity для КАЖДОГО ChartSection.** Ядро (WidgetExplorer) есть, но own-chrome legacy
  (history/velocity/heatmap/mentions) живут отдельно, а legacy-композиты («Показатели») shell-only (период/
  источник/размер/цвет, без viz/comparison). Чинить: «Explorer contract» обязателен для каждого ChartSection
  (через WidgetConfig ИЛИ adapter, отдающий period/viz/comparison/source capabilities). Долгосрочно: own-chrome
  → НАСТОЯЩИЕ catalogue-метрики с resolver-поддержкой (не shell-only legacy) — см. U6.3b.
- **Структура страниц (гибридный scroll-feed).** /analytics всё ещё содержит DOM «Обзор/Посты/Упоминания»
  (одна длинная проскролленная страница, route-модель `App.tsx`). Sidebar на 5 разделов — ок, если каждый =
  одна задача. Идея: /overview = executive scroll-summary; /analytics, /posts, /reports = сфокусированные
  рабочие места (сохранить «не заставлять кликать» через overview-summary).
- **Source/story/data-quality как ЕДИНАЯ подпись (поднять выше #4/#5).** Связать caption с data-quality:
  «последняя синхронизация», «окно неполное», «выборка N постов», «сравнение скрыто — baseline неполный».
  Прямо влияет на ДОВЕРИЕ (объединяет прежние #4/#5 caption + #15 data-quality).

**Новые дискретные пункты (в бэклог):** account-synced WidgetConfig store · IG/TG source-aware editor ·
universal explorer parity for every ChartSection · Playwright/visual QA @430/768/900/1440 · reduced-motion
для edit-анимации · export / open-as-metric / add-to-report из меню КАЖДОГО виджета (#7 object-model).

**Posts-table premium (#10):** важен, но ПОСЛЕ того как /posts станет настоящим разделом (иначе улучшения
таблицы тонут внутри общего feed).

### Motion pass: edit-mode choreography (отдельная задача, высокий ROI — «ощущение качества»)
Проблема: сейчас Edit = «состояние переключилось», у Steep = «интерфейс вошёл в режим». Кнопка делает лишь
color-toggle + crossfade иконок + remount текста (`index.css:251`, `Home.tsx:94`) → плоско. Правки:
- **Fixed-width Edit-кнопка** (min-w 116-124px, labels absolute/grid-overlay) — «Изменить»/«Готово» разной
  длины, микросдвиг ломает premium.
- **Настоящий press-state** (:active/pointerdown): scale .96, translateY .5px, фон foreground/6→/9, 70-90ms.
- **Icon morph/draw** (не crossfade): pencil rotate 0→18° / scale 1→.75 / opacity→0; check scale .75→1 /
  opacity 0→1 + draw через stroke-dasharray/dashoffset 180-220ms.
- **Развести timeline (stagger):** 0-90 press → 80-240 icon morph → 100-260 label crossfade → 140-340 card
  remove-кнопки staggered → 220-380 «+ Добавить виджет» последним. Кнопка «командует», страница отвечает.
- **Exit-анимация:** держать remove-controls в DOM, переключать opacity/scale/pointer-events (Готово→Изменить
  тоже плавно).
- **Прочее:** widget-jiggle слишком iOS/toy → уменьшить амплитуду ИЛИ спокойный edit-state (тонкая active-рамка
  + drag-handle); ⋯-меню popover-motion (opacity 0→1, scale .98→1, y -2→0, 100-130ms); explorer раскрывать из
  карточки (FLIP/card-origin scale); catalog→preview один shell с drill-in (не смена модалок); chart tooltip
  мягче (60-90ms opacity + мелкий y-offset); sidebar active = один sliding pill. Всё под prefers-reduced-motion.
- Самый высокий ROI: fixed-width кнопка + press physics + drawn check + staggered card controls + мягкий exit.

## Журнал

- 2026-07-04 — **Chart hover #9 ОСТАТОК SHIPPED** `64cc270`. Drilldown + legend-toggle (последний кусок #9;
  ядро-tooltip было `6359270`). (1) **Legend-toggle:** comparison-чип в LineChart/BarChart стал aria-pressed
  кнопкой (скрыть/показать ghost); скрытый ghost выпадает из y-домена → серия рескейлится. (2) **Drilldown:**
  opt-in `onPointClick` на чартах (hit-rects, pointer-cursor) + keyboard-доступная hero-кнопка в
  WidgetRenderer; оба от одного `onDrill`, который ConfigWidget берёт из `metric.drillKey` (6 core TG). Previews/
  explorer/IG/legacy — static (onDrill не прокидывается). **Ultracode adversarial-review (3 оси→verify, 8
  агентов): 4 confirmed + 1 refuted, все пофикшены:** [HIGH] stale ghostHidden (скрыл→сменил comparison/route→
  оставался скрыт) → content-signature reset-effect (НЕ по array-identity — иначе чип un-clickable на refetch с
  нестабильной ссылкой); [HIGH] pinned-source drill показывал ЧУЖОЙ канал (metric-page читает глобальный
  switcher, не config.source) → drill ПОДАВЛЕН на source-pinned картах (`config.source == null` гейт; proper
  channel-scoped drill → backlog); [MED] generic hero aria-label → threaded `drillLabel` («Разбор: <метрика>»
  как KpiGrid DrillValue); [LOW] MetricPage дубль-контрол (page-level «Сравнение» SegSelect + чип десинхрон) →
  `legendToggle={false}` на metric-page charts (static label вместо toggle). Гейт build+291. Файлы: LineChart/
  BarChart/WidgetRenderer/ConfigWidget/MetricPage. ⚠️ Живой визуал = прод (authed локально не рендерится).
  Осталось от #9: click-по-точке уже drill (сделано), клик-по-легенде toggle (сделано) — **#9 ЗАКРЫТ.**
- 2026-07-03 — **BUGFIX metric-page comparison undercount** (prod-audit находка). /metrics/views:
  hero (archive) показывал −9%, а rail «Сравнение» +969.3% (прошлый период 1.2k). Причина: post-derived
  метрики (views/reactions/…) суммируют `postsInBase` = fetch-capped(~100)/windowed посты за ПРЕДЫДУЩЕЕ
  окно; когда baseline старше oldest-loaded поста → сумма недосчитывает → бред-%. Тот же корень у sparse
  ghost-линии. Фикс: pure `baselineCoveredByPosts(dates, baseFrom)` в `lib/metricSeries.ts` (+4 теста, 287);
  MetricPage гейтит field-ghost + rail-compare на `baseCovered` (subscribers=archive, не задет). Adversarial-
  review: 0 дефектов. **Sibling #1 FIXED** (след. коммит): `baselineCoveredByPosts` получил опц.
  `capped=true` (default = поведение MetricPage без изменений); `!capped → всегда covered` (все посты
  загружены → сумма полна даже для sparse-канала, НЕ over-suppress). resolveWidgetMetric field-ghost
  теперь гейтит с `capped = normPostsAll.length >= 100` (сервер-кап). Backward-compat → старые resolver
  ghost-тесты (4 поста, не capped) зелены; +1 resolver-тест (100 постов capped+uncovered → ghost undefined),
  +2 helper-теста (290). **Sibling #2 FIXED** (тот же коммит-волна): MetricPage rank/pivot `baseByDim`
  compare-колонки теперь гейтятся на `baseCovered` (одна строка — `baseCovered` уже считался) → не
  недосчитывают и не спорят с подавленным rail «Изменение». **Undercount-класс закрыт целиком** (metric-
  page rail+ghost, config-widget ghost, rank/pivot compare). Прод-аудит: Home/Analytics/metric-pages/
  Posts/Overview/edit-dialog — чисто; KpiGrid-дельты archive-based (`dailyWindowDelta` из /api/history,
  reliable) → +340% на Overview 90д РЕАЛЬНЫЙ (рост-затем-спад, консистентно с 7д−38.7%/30д−9%).
- 2026-07-03 — **U6.3a SHIPPED** `57fcf0a`. 4 bare-legacy-блока (kpi/digest/growth/top-posts) рендерятся
  через ConfigWidget (единый card-chrome/editor/explorer). Решение: НЕ переписывать pinned деструктивно —
  bare-ключ = стабильный cross-device pointer, config device-local с детерминированным id `legacy-<key>`.
  Ultracode adversarial-review (5 осей→verify): 6 confirmed находок, ВСЕ один корень — смена identity
  `home-<key>`→`custom-legacy-<key>` сиротила старые prefs (period/size/title/accent/**source=wrong-channel
  HIGH**/hidden/reorder). Фикс = one-time миграция (`healedLegacyConfig`+`setWidgetHidden`+`remapGroupOrder`)
  в persist-эффекте, idempotent (отдельный verify-агент подтвердил: guard+детерминизм+no-op-on-repeat).
  Widen-нота восстановлена в LegacyWidgetBody. Гейт build+283.
- 2026-07-03 — **S12 SHIPPED** `8f39ed6` + **S9** `e52ff2b`. S9: target resolver-owned (fixed+dynamic)
  + «N% от цели» (review 0). S12: story-card стат-футер (Макс·Среднее). Tonal-фон/tooltip/TgAnalytics-
  миграция осознанно отложены (governance / риск live-страницы). **ПЛАН S1-S12 ЗАКРЫТ** (кроме опциональной
  миграции TgAnalytics). Итог: 31 метрика (20 TG + 11 IG), 269 тестов, движок→редактор→фильтры→сравнение→
  цель, всё на проде.
- 2026-07-03 — **S8 SHIPPED** `f426b96`. Сравнение-модель: display honor + month/custom + IG-ghost.
  Ревью поймало 2 LOW: netFollowers net-zero ghost (hasCur-gate), month-shift календарное выравнивание
  (grain-aware shiftMonthsUTC). Урок: shared-хелпер applyIgGhost — фикс scoped через opts, не глобально.
- 2026-07-03 — **S7 SHIPPED** `1b3c8ac`. Фильтры: `lib/dimensions.ts` + резолвер applyFilters +
  FilterBuilder. Ultracode-ревью поймал delta-инконсистентность (архивный тренд рядом с фильтр-value)
  → recompute/suppress из filtered windowTotals. Грабля: deriveKpis.windowTotals внутри Date.now() →
  тест suppression дат posts относительно now.
- 2026-07-03 — **S3c SHIPPED** `b9cfad8`. netGrowth + каталог скрыл table-kind.
- 2026-07-03 — **S11 SHIPPED** `a64a29d`. IG-пути: `igAggregations.ts` + резолвер IG-ветка +
  `useIgWidgetData` + ConfigWidget TG/IG-диспетч (компонентами, не хук) + каталог раскрыт. Резолвер
  = 31 метрика. Ultracode-ревью поймал 2 дефекта; верификатор скорректировал предложенный фикс
  netFollowers (hasCur, не series-all-zero — иначе сломался бы реальный net-zero). Живой IG = юзер.
- 2026-07-03 — **S10 SHIPPED** `1d308a9`. grain quarter/year, review 0 находок.
- 2026-07-03 — **S5 SHIPPED** `8971407`. `ConfigEditDialog` + ChartSection `configEditor`-хук.
  Ultracode: реализация → adversarial-review воркфлоу (5 осей: chartsection-regression/config-model/
  live-editing/control-gating/design-a11y, каждая находка verify-скептиком) → 2 фикса. Решения: config-
  виджет открывает свой диалог, display (accent/tint/size/target) из config; showComparison/showTarget=
  series-only (мёртвые контролы недопустимы). Legacy prefs-диалог остаётся для registry-виджетов.
- 2026-07-03 — **S6.3 SHIPPED** `54ba3c6`. `WidgetCatalogModal` + Home-монтаж. **Движок стал
  ВИДИМЫМ:** «Изменить» → «Добавить виджет» → «Метрика из каталога…» → поиск → клик = config-виджет
  на Главной (story-card). Решения: переиспользую ChartSection-chrome (reorder/expand/size/× работают
  бесплатно); IG-таб скрыт до S11 (иначе пустые карточки); registry-else-ветка байт-идентична. ⚠️
  ПЕРВЫЙ бандл-меняющий коммит — poll хеша на atlavue.app; живой визуал = юзер (authed локально нет).
- 2026-07-03 — **S6.2 SHIPPED** `880205b`. `useWidgetData` + `ConfigWidget`. Bridge движок↔React.
  Решение: ConfigWidget переиспользует ChartSection-chrome (id=`custom-<id>`), данные из config (не prefs);
  useTgFull windowPair (как MetricPage, для ghost-baseline); ChannelScope при config.source. Ещё НЕ смонтирован.
- 2026-07-03 — **S6.1 SHIPPED** `508acda`. `lib/widgetStore.ts` + тест. Отложенный из S2 стор.
  Решения: standalone-модуль (не трогаю prefs-sync в ChartWidget); стабильный snapshot-кеш (память:
  useSyncExternalStore без него = loop); account-sync отложен (device-local first); `__resetWidgetStoreCache`
  как тест-seam. **Движок целиком (S1-S4+S6.1) готов и протестирован, но НЕ смонтирован (tree-shaken).**
- 2026-07-03 — **S4 SHIPPED** `1205b65`. `WidgetRenderer.tsx` (story-card) + `lib/widgetRender.ts`
  (pure) + тест. Решения: pure-логика форматирования вынесена в lib (RTL/jsdom в проекте нет → компонент
  только typecheck); `effectiveViz` — graceful fallback (rank/pivot/table → data-shape, не рендерятся из
  WidgetResult); монтирование отложено до S6; ПОРЯДОК S5↔S6 переставлен (S6 mount перед S5 editor — редактор
  нужен config-виджетам, которых нет до монтирования).
- 2026-07-03 — **S3b SHIPPED** `6a41b82`. `lib/tgAggregations.ts` (12 breakdown-агрегаторов, порт
  из TgAnalytics) + резолвер расширен. Решение: НЕ трогаю живую TgAnalytics (нет локального authed-
  рендера → нельзя визуально верифицировать) — извлёк+протестировал логику, миграция панели позже (S12).
  all-zero weekday/hours = empty. графы период-агностичны (как в текущих виджетах).
- 2026-07-03 — **S3a SHIPPED** `7386ba5`. Резолвер `lib/resolveWidgetMetric.ts` ядро + тест.
  Решения: `DataContext` несёт УЖЕ разрешённое окно (render-слой сворачивает config.period) +
  `now` — резолвер pure/детерминирован (тесты фиксируют now, ни одного Date.now()); series = raw
  bucket keys (форматирует S4-рендерер); value core = строка из deriveKpis (примиряется с ledger);
  er/avgReach series = подлежащая сумма (как MetricPage); comparison month/custom → нет ghost (S8).
  S3b (breakdown-агрегаторы из TgAnalytics) — следующая итерация.
- 2026-07-03 — **S2 SHIPPED** `0a6c8b8`. Модель `lib/widgetConfig.ts` + тест. Решения: под-типы
  comparison/target/filter по спеке S7-S9 сразу (forward-compat, round-trip fixpoint заперт тестом);
  grain до `year` (S10 форвард); `import type WidgetSize` из ChartWidget (erased, pure lib сохранён);
  store+sync отложен до S4-потребителя (не плодить мёртвый localStorage-ключ). Баг `source:0.4→0`
  пойман само-ревью (round ДО проверки >0).
- 2026-07-03 — **S1 SHIPPED** `8863cac`. Каталог `lib/widgetMetrics.ts` + тест. Донор-код изучен
  (metricDefs/kpiDerive/MetricPage/metricSeries/reportBlocks/ChartWidget/homeWidgets/TgAnalytics/
  igMetrics). Решения: id source-namespaced (`tg.*`/`ig.*`); `seriesAgg: flow|level` для S10 grain;
  `drillKey` связывает 6 KPI с deriveKpis (для S3); тексты «О метрике» перенесены (rename `source`→
  `sourceNote`). Ординальные breakdown (weekday/hours/postCount) осознанно bar/line без list.
