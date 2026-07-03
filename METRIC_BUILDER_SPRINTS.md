# METRIC_BUILDER_SPRINTS — трекер трека «конструктор метрик» (Steep-parity)

Source of truth для этого трека. План: `STEEP_METRIC_BUILDER.md`. Статусы: TODO / WIP / SHIPPED `<commit>`.

Гейт каждой задачи (перед пушем): `npm --prefix frontend run build` + `npm --prefix frontend run test`
(было 152 теста) + adversarial-само-ревью. Server — `node --check` + server-тесты. Git: add только свои
файлы, bundle-hash poll после push.

## Спринты

- **S1 — Каталог метрик `lib/widgetMetrics.ts`** — WIP
  Единый `MetricDef[]` (id/label/source/kind/unit/defaultViz/supportedViz/dimensions/category) поверх
  metricDefs + kpiDerive DrillKey + TgAnalytics derived + IG (igMetrics). React-free + unit-тест. Ничего
  в рендере не трогает.
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

(пусто — трек только начат)
