-- ── СДЭК Fulfillment — источник с ручной загрузкой Excel ─────────────────────
-- Первый источник БЕЗ API: данные приезжают выгрузкой из личного кабинета СДЭКа
-- (orders_export*.xlsx), которую пользователь загружает руками. Поэтому здесь нет ни токена,
-- ни крона: identity источника — код склада, а «свежесть» задаёт последний импорт.
-- Схема СТАТИЧЕСКАЯ (решение владельца): колонки выгрузки известны, динамического
-- определения структуры нет.
--
-- Зерно разложено на ДВЕ таблицы, потому что выгрузка ДЕНОРМАЛИЗОВАНА: одна строка =
-- товар в заказе, поля заказа повторяются по строкам (в эталонном файле 1126 строк на
-- 1100 заказов). COUNT(*) по строкам как «заказы» завышает на 2.4% и растёт вместе со
-- средним размером корзины — отсюда отдельные cdek_orders и cdek_order_items.
--
-- ADDITIVE-ONLY + идемпотентно (IF NOT EXISTS), откат = git revert.

-- Источник: одна строка на канал, зеркально ms_accounts (026)/ym_accounts (033), но без
-- секретов — хранить нечего. tz нужен, потому что выгрузка печатает НАИВНОЕ локальное время
-- («2025-07-31 15:39:48» строкой): в timestamptz оно переводится через AT TIME ZONE, что
-- корректно переживает перевод часов. warehouse_code («Склад» в выгрузке) — идентичность
-- фулфилмент-аккаунта, по ней дедупятся повторные подключения того же склада.
CREATE TABLE IF NOT EXISTS cdek_sources (
  channel_id     INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  warehouse_code TEXT,
  tz             TEXT NOT NULL DEFAULT 'Europe/Moscow',
  source_id      INTEGER REFERENCES external_sources(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Импорт = один загруженный файл. Это и аудит («откуда взялась эта цифра»), и идемпотентность,
-- и поверхность отчёта. file_bytes держит СЫРОЙ файл: правила классификации строк живут в коде,
-- и при их изменении импорт переигрывается из исходника, а не просится у пользователя заново.
-- rejected/warnings — усечённые списки для отчёта (полный файл всегда рядом, в file_bytes).
CREATE TABLE IF NOT EXISTS cdek_imports (
  id            SERIAL PRIMARY KEY,
  channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename      TEXT NOT NULL,
  file_sha256   TEXT NOT NULL,
  file_bytes    BYTEA,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
  rows_total    INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_updated  INTEGER NOT NULL DEFAULT 0,
  rows_rejected INTEGER NOT NULL DEFAULT 0,
  rows_deleted  INTEGER NOT NULL DEFAULT 0,   -- позиции, исчезнувшие из заказа в новой версии
  orders_total  INTEGER NOT NULL DEFAULT 0,
  period_from   DATE,
  period_to     DATE,
  rejected      JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings      JSONB NOT NULL DEFAULT '[]'::jsonb,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS cdek_imports_channel_idx ON cdek_imports (channel_id, created_at DESC);
-- Повторная загрузка того же файла — no-op, а не второй проход: уникальность держится ТОЛЬКО
-- по успешным импортам, чтобы упавший (status='error') не блокировал повтор после починки.
CREATE UNIQUE INDEX IF NOT EXISTS cdek_imports_file_idx
  ON cdek_imports (channel_id, file_sha256) WHERE status = 'done';

-- Заказ (зерно: ЗАКАЗ). Upsert по (channel_id, order_id) ЗАМЕНЯЕТ строку целиком, не
-- COALESCE'ит: статус заказа правится задним числом (delivery → complete), и перевыгрузка с
-- нахлёстом обязана донести правку. kind отделяет продажи от складских движений
-- («Корректировка остатков», «ПЕРЕМЕЩЕНИЕ НА БРАК», «Самовывоз брака») — в эталонном файле их
-- 7 строк из 1126, но они завышают наивную выручку на 176 тыс ₽ (5%); вместе с отменами —
-- на 12.2%. Классификация проставляется на импорте и хранится, чтобы отчёт мог показать, ЧТО
-- именно отсеяно, а не молча вычитать.
CREATE TABLE IF NOT EXISTS cdek_orders (
  channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  order_id          TEXT NOT NULL,                -- «ID» выгрузки
  created_ts        TIMESTAMPTZ NOT NULL,         -- «Создан», наивное локальное → tz источника
  status            TEXT NOT NULL,                -- complete / delivery / cancel / return (без CHECK: новый статус СДЭКа не должен ронять импорт)
  carrier           TEXT,                         -- «Служба доставки» как в файле
  channel           TEXT,                         -- нормализованный канал продаж: own / wildberries / yandex_market / ozon / other
  external_order_id TEXT,                         -- «Внешний ID» — номер заказа на маркетплейсе
  track_number      TEXT,                         -- «Трек-номер» (есть только у своей доставки)
  warehouse_code    TEXT,                         -- «Склад»; пусто ⟺ резерв снят (отменён или отгружен)
  comment           TEXT,
  kind              TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale', 'stock_move')),
  import_id         INTEGER REFERENCES cdek_imports(id) ON DELETE SET NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, order_id)
);
CREATE INDEX IF NOT EXISTS cdek_orders_channel_ts_idx ON cdek_orders (channel_id, created_ts);
-- Оконные чтения аналитики почти всегда «продажи за период» — частичный индекс под них.
CREATE INDEX IF NOT EXISTS cdek_orders_sales_idx
  ON cdek_orders (channel_id, created_ts) WHERE kind = 'sale';

-- Строка заказа (зерно: ТОВАР В ЗАКАЗЕ). unit_price_kopecks — ЦЕНА ЗА ШТУКУ, не сумма строки:
-- доказано данными эталонного файла (товар BG-GR7T при «Количество» 5 и 7 несёт одну и ту же
-- «Стоимость товара» 3750). 99% строк имеют количество 1, поэтому наивное «сумма = стоимость»
-- было бы верно почти везде и молча врало на остальном — формула зашита в схему, а не
-- пересобирается в каждом запросе.
CREATE TABLE IF NOT EXISTS cdek_order_items (
  channel_id         INTEGER NOT NULL,
  order_id           TEXT NOT NULL,
  product_id         TEXT NOT NULL,               -- «ID товара»
  unit_price_kopecks BIGINT NOT NULL DEFAULT 0,
  qty                INTEGER NOT NULL DEFAULT 0,
  qty_reserved       INTEGER,                     -- операционный признак склада, не метрика
  amount_kopecks     BIGINT GENERATED ALWAYS AS (unit_price_kopecks * qty) STORED,
  import_id          INTEGER REFERENCES cdek_imports(id) ON DELETE SET NULL,
  PRIMARY KEY (channel_id, order_id, product_id),
  FOREIGN KEY (channel_id, order_id) REFERENCES cdek_orders (channel_id, order_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS cdek_order_items_product_idx ON cdek_order_items (channel_id, product_id);

-- Справочник товаров (зерно: ТОВАР), 54 позиции в эталонном файле. «Последнее значение
-- выигрывает»: название/артикул товара переименовывают, и свежая выгрузка — более верный
-- источник, чем первая. Штрих-коды приходят СПИСКОМ через запятую и не всегда числом
-- («S/I/PO34527292*, 2047711458704») — поэтому массив текста, а не одно поле.
CREATE TABLE IF NOT EXISTS cdek_products (
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL,
  title       TEXT,
  article     TEXT,
  sku         TEXT,
  barcodes    TEXT[] NOT NULL DEFAULT '{}',
  external_id TEXT,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, product_id)
);

-- Расширение CHECK external_sources.network до 'cdek' — тот же гейтованный DO-блок, что в 026 и
-- 033 (ADD CONSTRAINT IF NOT EXISTS появился только в PG16): уже расширенный constraint
-- (содержит 'cdek') не передёргивается, повторный прогон безопасен на любой версии.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_sources_network_check'
       AND conrelid = 'external_sources'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%''cdek''%'
  ) THEN
    ALTER TABLE external_sources DROP CONSTRAINT external_sources_network_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_sources_network_check'
       AND conrelid = 'external_sources'::regclass
  ) THEN
    ALTER TABLE external_sources
      ADD CONSTRAINT external_sources_network_check
      CHECK (network IN ('tg', 'ig', 'ms', 'ym', 'cdek'));
  END IF;
END$$;
