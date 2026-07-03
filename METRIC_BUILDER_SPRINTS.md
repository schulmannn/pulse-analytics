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
- **S2 — Модель `WidgetConfig` `lib/widgetConfig.ts`** — TODO
- **S3 — Единый резолвер `lib/resolveWidgetMetric.ts`** — TODO
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

- 2026-07-03 — **S1 SHIPPED** `8863cac`. Каталог `lib/widgetMetrics.ts` + тест. Донор-код изучен
  (metricDefs/kpiDerive/MetricPage/metricSeries/reportBlocks/ChartWidget/homeWidgets/TgAnalytics/
  igMetrics). Решения: id source-namespaced (`tg.*`/`ig.*`); `seriesAgg: flow|level` для S10 grain;
  `drillKey` связывает 6 KPI с deriveKpis (для S3); тексты «О метрике» перенесены (rename `source`→
  `sourceNote`). Ординальные breakdown (weekday/hours/postCount) осознанно bar/line без list.
