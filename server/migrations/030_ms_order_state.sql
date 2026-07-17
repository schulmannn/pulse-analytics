-- ── МойСклад: id статуса заказа в архиве ms_orders (слайс 3 — воронка статусов) ────────
-- Без expand МС отдаёт state meta-only ссылкой (имени в строке заказа нет — колонка state
-- почти всегда NULL), поэтому храним УСТОЙЧИВЫЙ id статуса (последний сегмент
-- state.meta.href, ровно как agent_id) и мапим его в имя/цвет словарём
-- GET /entity/customerorder/metadata на границе API (кэш 1 час). Старые строки получают
-- state_id повторным прогоном бэкфилла (кнопка), свежие — дневной доливкой.
ALTER TABLE ms_orders ADD COLUMN IF NOT EXISTS state_id TEXT;
