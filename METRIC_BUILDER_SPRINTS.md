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
- **S3 — Единый резолвер `lib/resolveWidgetMetric.ts`** — WIP (S3a `7386ba5` + S3b `<pending>` SHIPPED)
  `resolveWidgetMetric(config, ctx): WidgetResult`. **S3a:** ядро — 6 core TG как value+delta+caption
  (`deriveKpis`) + grain-series + ghost (`comparisonWindow`/`alignGhost`); erv/virality как value.
  `DataContext` = pre-resolved окно (`now/days/range/inRange`) + payloads → pure/детерминирован. Series
  = raw bucket keys. Никогда не бросает (`empty:true`). **S3b:** TG breakdown (emoji/formatPerf/weekday/
  postCount/engagementComposition/viewsByType/viewsBySource/newFollowersBySource/languages/sentiment/
  hours/churn) через новый pure `lib/tgAggregations.ts` (порт агрегаторов из TgAnalytics, БЕЗ трогания
  живой страницы — миграция самой TgAnalytics → S12). +graphs в DataContext. all-zero breakdown = empty.
  **Резолвер покрывает 20 метрик.** 19 тестов (204 всего). **S3c (TODO):** netGrowth (series-из-graphs)
  + tables (weeklyTable/topPosts). **IG → S11.** Nothing imports it yet (tree-shaken).
- **S4 — Единый рендерер `components/WidgetRenderer.tsx`** — TODO
- **S5 — Универсальный Widget Editor (расширить EditWidgetDialog)** — TODO
- **S6 — Add-widget как searchable catalog `components/WidgetCatalogModal.tsx`** — TODO
- **S7 — Per-widget фильтры `FilterBuilder` + каталог DIMENSIONS** — TODO
- **S8 — Сравнение как настройка модели** — TODO
- **S9 — Target / forecast** — TODO
- **S10 — Богаче grain (day..year, flow vs level)** — TODO
- **S11 — IG-метрики в каталог (self-fetching)** — TODO
- **S12 — Визуальный слой ПОСЛЕ модели** — TODO

## Журнал

- 2026-07-03 — **S3b SHIPPED** `<pending>`. `lib/tgAggregations.ts` (12 breakdown-агрегаторов, порт
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
