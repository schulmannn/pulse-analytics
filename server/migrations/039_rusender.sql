-- ── Rusender (Public API v1) — источник email-рассылок, per-channel ──────────
-- Пятый внешний источник, зеркально ms_accounts (026)/ym_accounts (033): один аккаунт Rusender
-- на канал, API-ключ хранится ТОЛЬКО шифрованным (AES-256-GCM через RUSENDER_KEY).
-- identity аккаунта — accountId из GET /v1/public/me (стабилен, по нему дедупятся повторные
-- подключения того же аккаунта); account_email — витринная подпись источника.
--
-- ГРАНИЦА ИСТОЧНИКА: считаем ТОЛЬКО рассылки (campaigns) — решение владельца. У Rusender есть
-- вторая, НЕСВЯЗАННАЯ семья величин: транзакционные письма по ключам отправки
-- (/v1/public/external-mails). Это разные величины с разными знаменателями, и складывать их в
-- одно число нельзя — тот же канон, что «TG-просмотры ≠ IG-охват». Транзакционная семья сюда
-- сознательно НЕ заводится; если она понадобится, у неё будут свои таблицы и свои экраны.
--
-- ADDITIVE-ONLY + идемпотентно (IF NOT EXISTS), откат = git revert.

CREATE TABLE IF NOT EXISTS rusender_accounts (
  channel_id    INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL,          -- accountId из /v1/public/me — идентичность аккаунта
  account_email TEXT,                   -- витринная подпись источника (не секрет)
  scopes        TEXT[],                 -- разрешения ключа: витрина «чего ключу не хватает»
  api_key_enc   TEXT NOT NULL,          -- AES-256-GCM, формат: ivHex:tagHex:cipherHex
  source_id     INTEGER REFERENCES external_sources(id),
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Дневной снимок БАЗЫ КОНТАКТОВ — единственный источник этой истории. У Rusender
-- /v1/public/contacts/statistics отдаёт только «сейчас»: истории размера базы у API НЕТ.
-- Поэтому дневной джоб штампует снимок раз в день, и график роста базы начинается с даты
-- подключения, а не с рождения аккаунта. Дорисовывать прошлое нечем — и не надо.
--
-- Все счётчики NULLABLE СОЗНАТЕЛЬНО: «снимок в этот день не снят» ≠ «в базе было 0 контактов».
-- Пустой день обязан читаться как дыра в сборе, а не как обнулившаяся база.
--
-- Открытий/кликов ЗДЕСЬ НЕТ и быть не должно: они живут в rusender_campaign_activity (дневная
-- активность по рассылке) и сворачиваются в дневной поток на чтении. Хранить их вторым местом
-- значит завести две правды об одном числе и рано или поздно их разойтись.
CREATE TABLE IF NOT EXISTS rusender_daily (
  channel_id            INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  day                   DATE NOT NULL,
  contacts_total        BIGINT,   -- всего контактов
  contacts_active       BIGINT,   -- активные
  contacts_unsubscribed BIGINT,   -- отписавшиеся
  contacts_unavailable  BIGINT,   -- недоступные (жалобы + bounced + ошибки)
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, day)
);

-- Рассылки — контент-единицы источника (аналог posts у TG, ms_orders у МойСклада).
-- Одна строка на рассылку, снимок статистики целиком ПЕРЕЗАПИСЫВАЕТСЯ каждым проходом:
-- у Rusender это кумулятивные счётчики живой кампании (открытия докапывают неделями,
-- статус меняется, рассылку переименовывают), и свежий снимок обязан заменить старый,
-- а не «дополнить» его.
--
-- ВАЖНО ПРО ВРЕМЯ: total/delivered/opens/clicks/... — это ИТОГИ РАССЫЛКИ, а не события дня.
-- Привязать их к дню можно только по started_at (день запуска) — и именно так их и читают
-- витрины. Дневной поток открытий/кликов берётся из rusender_campaign_activity, где он
-- настоящий, а не разложенный по дню старта.
CREATE TABLE IF NOT EXISTS rusender_campaigns (
  channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  campaign_id       BIGINT NOT NULL,
  name              TEXT,
  subject           TEXT,
  preview_title     TEXT,
  type              TEXT,      -- regular | ab_basic | ab_variant | follow_up_basic | follow_up | chunked
  status            TEXT,      -- draft | built | scheduled | in_progress | paused | completed | banned | on_hold
  sender_email      TEXT,
  sender_name       TEXT,
  list_names        TEXT[],    -- списки-получатели (витринные имена, для подписи рассылки)
  is_archived       BOOLEAN NOT NULL DEFAULT false,
  scheduled_at      TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  remote_created_at TIMESTAMPTZ,   -- createdAt на стороне Rusender (не наш created_at)
  -- Итоги рассылки. NULLABLE: withStats может не приехать (нет scope, черновик), и «статистики
  -- нет» ≠ «ноль доставленных».
  total             BIGINT,
  sending           BIGINT,
  delivered         BIGINT,
  opens             BIGINT,
  clicks            BIGINT,
  errors            BIGINT,
  unsubscribes      BIGINT,
  complaints        BIGINT,
  -- Курсор ротации дневной активности: когда последний раз тянули /activity этой рассылки.
  -- Проход обновляет активность ограниченной пачки (свежие + ротация по этому полю), поэтому
  -- аккаунт с сотнями рассылок не выжигает квоту за один заход.
  activity_synced_at TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, campaign_id)
);
-- Лента рассылок и окно «за период» ходят по дню запуска, свежие сверху.
CREATE INDEX IF NOT EXISTS rusender_campaigns_started_idx
  ON rusender_campaigns (channel_id, started_at DESC);
-- Планировщик ротации активности: «кого давно не обновляли» (NULLS FIRST — ни разу не тянули).
CREATE INDEX IF NOT EXISTS rusender_campaigns_activity_idx
  ON rusender_campaigns (channel_id, activity_synced_at ASC NULLS FIRST);

-- Дневная активность рассылки (GET /v1/public/campaigns/{id}/activity) — ЕДИНСТВЕННЫЙ
-- настоящий временной ряд во всём API Rusender. Отсюда сворачивается дневной поток открытий
-- и кликов источника; здесь же лежит кривая жизни отдельной рассылки.
--
-- Семантика ЗАМЕНЯЮЩАЯ, не COALESCE: открытия старой рассылки продолжают докапывать, и
-- повторный проход обязан донести новое значение дня (в т.ч. вниз — Rusender пересматривает
-- дедуп открытий), а не оставить первое увиденное.
CREATE TABLE IF NOT EXISTS rusender_campaign_activity (
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  campaign_id BIGINT NOT NULL,
  day         DATE NOT NULL,
  opens       BIGINT NOT NULL DEFAULT 0,
  clicks      BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, campaign_id, day)
);
-- Свёртка дневного потока источника: GROUP BY day по каналу в окне периода.
CREATE INDEX IF NOT EXISTS rusender_campaign_activity_day_idx
  ON rusender_campaign_activity (channel_id, day);

-- Расширение CHECK external_sources.network до 'rusender' — тот же гейтованный DO-блок, что в
-- 026/033/038 (ADD CONSTRAINT IF NOT EXISTS появился только в PG16): уже расширенный constraint
-- (содержит 'rusender') не передёргивается, повторный прогон безопасен на любой версии.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_sources_network_check'
       AND conrelid = 'external_sources'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%''rusender''%'
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
      CHECK (network IN ('tg', 'ig', 'ms', 'ym', 'cdek', 'rusender'));
  END IF;
END$$;
