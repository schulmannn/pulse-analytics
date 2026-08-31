'use strict';

/* ── Rusender: учётка источника, архив рассылок и дневная активность (миграция 039) ─────────────

   Пятый внешний источник. Учётка зеркалит ms_accounts/ym_accounts: API-ключ приходит и отдаётся
   УЖЕ шифрованным (callers шифруют через lib/rusender_crypto) — repo никогда не видит plaintext
   и не логирует его.

   ДВЕ ЧЕСТНЫЕ ПРАВДЫ О ВРЕМЕНИ — главное, что стоит понять про этот источник:
     • «События периода» — открытия и клики, СЛУЧИВШИЕСЯ в окне (rusender_campaign_activity).
       Сюда попадают открытия старых рассылок: письмо, отправленное месяц назад, продолжает
       открываться сегодня.
     • «Рассылки периода» — итоги кампаний, ЗАПУЩЕННЫХ в окне (rusender_campaigns). Здесь
       открытия кумулятивные и относятся к рассылке целиком, а не к дню.
   Это РАЗНЫЕ числа, и они не обязаны совпадать — тот же канон, что «Просмотры канала» ≠
   «Просмотры публикаций» у Telegram. Оба читаются отдельными полями и подписываются отдельно;
   складывать их в одно число нельзя.

   ДЕНЬ РАССЫЛКИ — календарный день её ЗАПУСКА в зоне источника: (started_at AT TIME ZONE tz)::date.
   Функция по колонке не берёт индекс rusender_campaigns_started_idx для фильтра, и это осознанно:
   у канала сотни-тысячи рассылок, seq-scan по ним дешевле, чем вторая денормализованная колонка
   дня, которая рано или поздно разойдётся с started_at. Индекс продолжает работать на ORDER BY.

   Каждый метод несёт channel_id — инвариант «любой tenant-read/write содержит channel_id» без
   исключений; читающие методы дополнительно проходят ownership-чек канала (getAccessibleChannel),
   даже когда роут уже резолвил канал: defense in depth. */

// Потолок строк ленты рассылок за один ответ: лента виртуализируется на фронте, но сервер не
// обязан отдавать всё разом. Совпадает по духу с CDEK_ORDERS_MAX_ROWS.
const CAMPAIGNS_MAX_ROWS = 500;
// Потолок рассылок, у которых один проход крона обновляет дневную активность. Каждая — свой
// HTTP-запрос, поэтому число небольшое: свежие обновляются всегда, архив вращается по кругу.
const ACTIVITY_REFRESH_CAP = 40;
// «Свежая» рассылка: запущена не позже стольких дней назад ИЛИ ещё идёт. Открытия докапывают
// в основном первые недели, поэтому дальше архив можно вращать медленно.
const ACTIVITY_FRESH_DAYS = 30;

/** Статусы, у которых рассылка ещё живёт и её активность обязана обновляться каждый проход. */
const LIVE_STATUSES = ['in_progress', 'paused', 'scheduled'];

function createRusenderRepo({ pool, enabled, transaction, ensureExternalSource, getAccessibleChannel }) {
  const allowed = (channelId, actor) =>
    (getAccessibleChannel ? getAccessibleChannel(channelId, actor) : Promise.resolve(null));

  // ── Учётка источника ────────────────────────────────────────────────────────────────────────

  /**
   * Сохранить/обновить учётку. Зеркало saveYmAccount: канонический rusender-source → строка
   * учётки → штамп source_id канала — ОДНОЙ транзакцией, чтобы падение между записями не
   * оставило учётку без source-связки.
   *
   * Идентичность источника — accountId Rusender: два канала одного аккаунта схлопываются в один
   * external_sources, как два канала одного счётчика Метрики. account_email идёт как username
   * (ближайший аналог хэндла), он же — title, если другого имени нет.
   */
  async function saveRusenderAccount(channelId, { account_id, account_email, scopes, api_key_enc }) {
    if (!enabled || !channelId || !account_id) return false;
    const scopeList = Array.isArray(scopes) ? scopes.map((s) => String(s)).slice(0, 64) : null;
    return transaction(async (client) => {
      const srcId = await ensureExternalSource(
        'rusender',
        String(account_id),
        { username: account_email || null, title: account_email || null },
        client,
      );
      await client.query(
        `INSERT INTO rusender_accounts (channel_id, account_id, account_email, scopes, api_key_enc, source_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (channel_id) DO UPDATE SET
           account_id=EXCLUDED.account_id,
           account_email=EXCLUDED.account_email,
           scopes=EXCLUDED.scopes,
           api_key_enc=EXCLUDED.api_key_enc,
           source_id=COALESCE(EXCLUDED.source_id, rusender_accounts.source_id),
           updated_at=now()`,
        [channelId, String(account_id), account_email || null, scopeList, api_key_enc, srcId],
      );
      await client.query(
        `UPDATE channels SET source_id=$2
           WHERE id=$1 AND source_id IS NULL AND tg_channel_id IS NULL AND source='rusender'`,
        [channelId, srcId],
      );
      return true;
    });
  }

  /** Полная строка вместе с шифрованным ключом (callers дешифруют). null = не подключён. */
  async function getRusenderAccount(channelId) {
    if (!enabled || !channelId) return null;
    const { rows } = await pool.query(
      `SELECT channel_id, account_id, account_email, scopes, api_key_enc,
              to_char(connected_at,'YYYY-MM-DD"T"HH24:MI:SS') AS connected_at
         FROM rusender_accounts WHERE channel_id=$1`,
      [channelId],
    );
    return rows[0] || null;
  }

  /**
   * Все подключённые аккаунты ЖИВЫХ каналов — для доверенного дневного крона. Зеркало
   * listYmAccounts: JOIN-фильтр status<>'disabled' (выключенный канал не тратит квоту Rusender
   * на сбор, который никто не читает), без ownership-фильтра — крон доверенный. account_id
   * нужен ключу durable per-day гейта: reconnect ДРУГОГО аккаунта тем же каналом не наследует
   * сегодняшний succeeded.
   */
  async function listRusenderAccounts() {
    if (!enabled) return [];
    const { rows } = await pool.query(
      `SELECT ra.channel_id, ra.account_id, ra.account_email, ra.api_key_enc
         FROM rusender_accounts ra
         JOIN channels c ON c.id = ra.channel_id AND c.status <> 'disabled'
        ORDER BY ra.channel_id ASC`,
    );
    return rows;
  }

  /**
   * Отключение источника: сносим ТОЛЬКО строку учётки (ключ). Канал и архив (rusender_daily,
   * rusender_campaigns, rusender_campaign_activity) живут дальше — история остаётся читаемой,
   * повторный connect того же аккаунта её продолжит. Так же ведут себя МС и Метрика.
   */
  async function deleteRusenderAccount(channelId) {
    if (!enabled || !channelId) return false;
    const { rowCount } = await pool.query('DELETE FROM rusender_accounts WHERE channel_id=$1', [channelId]);
    return rowCount > 0;
  }

  // ── Запись архива (крон) ────────────────────────────────────────────────────────────────────

  /**
   * Дневной снимок базы контактов. rows: [{ day:'YYYY-MM-DD', contacts_total, contacts_active,
   * contacts_unsubscribed, contacts_unavailable }].
   *
   * Семантика ЗАМЕНЯЮЩАЯ (не COALESCE): за день снимок берётся один, повторный проход того же
   * дня обязан донести более свежее число, а не оставить утреннее. Счётчики пишутся КАК ЕСТЬ,
   * без COALESCE к нулю: «снимок не снят» обязано остаться NULL, а не стать ложным нулём.
   */
  async function upsertRusenderDaily(channelId, rows, executor = pool) {
    if (!enabled || !channelId || !rows || !rows.length) return 0;
    const sql = `INSERT INTO rusender_daily
        (channel_id, day, contacts_total, contacts_active, contacts_unsubscribed, contacts_unavailable, updated_at)
      SELECT $1, x.day::date, x.contacts_total, x.contacts_active,
             x.contacts_unsubscribed, x.contacts_unavailable, now()
        FROM jsonb_to_recordset($2::jsonb) AS x(
          day text, contacts_total bigint, contacts_active bigint,
          contacts_unsubscribed bigint, contacts_unavailable bigint
        )
      ON CONFLICT (channel_id, day) DO UPDATE SET
        contacts_total=EXCLUDED.contacts_total,
        contacts_active=EXCLUDED.contacts_active,
        contacts_unsubscribed=EXCLUDED.contacts_unsubscribed,
        contacts_unavailable=EXCLUDED.contacts_unavailable,
        updated_at=now()`;
    await executor.query(sql, [channelId, JSON.stringify(rows)]);
    return rows.length;
  }

  /**
   * Архив рассылок. rows: [{ campaign_id, name, subject, preview_title, type, status,
   * sender_email, sender_name, list_names[], is_archived, scheduled_at, started_at, finished_at,
   * remote_created_at, total, sending, delivered, opens, clicks, errors, unsubscribes, complaints }].
   *
   * Строка ЗАМЕНЯЕТСЯ целиком (не COALESCE): у живой рассылки растут открытия, меняется статус,
   * её переименовывают и архивируют — повторный проход обязан донести правку, в том числе вниз.
   * ИСКЛЮЧЕНИЕ — activity_synced_at: это НАШ курсор ротации, а не поле upstream'а, и обычный
   * upsert рассылки не имеет права его сбрасывать (иначе ротация активности никогда не сдвинется).
   *
   * Строки без campaign_id отбрасываются здесь же — дырявая строка иначе уронила бы jsonb-каст
   * всего батча (канон dayOf у МС/IG).
   */
  async function upsertRusenderCampaigns(channelId, rows, executor = pool) {
    if (!enabled || !channelId || !rows || !rows.length) return 0;
    const clean = rows.filter((r) => r && r.campaign_id != null);
    if (!clean.length) return 0;
    const sql = `INSERT INTO rusender_campaigns
        (channel_id, campaign_id, name, subject, preview_title, type, status,
         sender_email, sender_name, list_names, is_archived,
         scheduled_at, started_at, finished_at, remote_created_at,
         total, sending, delivered, opens, clicks, errors, unsubscribes, complaints, updated_at)
      SELECT $1, x.campaign_id, x.name, x.subject, x.preview_title, x.type, x.status,
             x.sender_email, x.sender_name,
             CASE WHEN x.list_names IS NULL THEN NULL
                  ELSE ARRAY(SELECT jsonb_array_elements_text(x.list_names)) END,
             COALESCE(x.is_archived, false),
             x.scheduled_at, x.started_at, x.finished_at, x.remote_created_at,
             x.total, x.sending, x.delivered, x.opens, x.clicks, x.errors, x.unsubscribes, x.complaints, now()
        FROM jsonb_to_recordset($2::jsonb) AS x(
          campaign_id bigint, name text, subject text, preview_title text, type text, status text,
          sender_email text, sender_name text, list_names jsonb, is_archived boolean,
          scheduled_at timestamptz, started_at timestamptz, finished_at timestamptz,
          remote_created_at timestamptz,
          total bigint, sending bigint, delivered bigint, opens bigint, clicks bigint,
          errors bigint, unsubscribes bigint, complaints bigint
        )
      ON CONFLICT (channel_id, campaign_id) DO UPDATE SET
        name=EXCLUDED.name, subject=EXCLUDED.subject, preview_title=EXCLUDED.preview_title,
        type=EXCLUDED.type, status=EXCLUDED.status,
        sender_email=EXCLUDED.sender_email, sender_name=EXCLUDED.sender_name,
        list_names=EXCLUDED.list_names, is_archived=EXCLUDED.is_archived,
        scheduled_at=EXCLUDED.scheduled_at, started_at=EXCLUDED.started_at,
        finished_at=EXCLUDED.finished_at, remote_created_at=EXCLUDED.remote_created_at,
        total=EXCLUDED.total, sending=EXCLUDED.sending, delivered=EXCLUDED.delivered,
        opens=EXCLUDED.opens, clicks=EXCLUDED.clicks, errors=EXCLUDED.errors,
        unsubscribes=EXCLUDED.unsubscribes, complaints=EXCLUDED.complaints,
        updated_at=now()`;
    await executor.query(sql, [channelId, JSON.stringify(clean)]);
    return clean.length;
  }

  /**
   * Дневная активность одной рассылки. rows: [{ day:'YYYY-MM-DD', opens, clicks }].
   * Семантика ЗАМЕНЯЮЩАЯ: открытия докапывают, и повторный проход обязан донести новое значение
   * дня (в т.ч. вниз — Rusender пересматривает дедуп). Курсор ротации (activity_synced_at)
   * ставится ТОЙ ЖЕ транзакцией: иначе сбой между записью и отметкой либо потерял бы данные,
   * либо навсегда закрыл бы рассылке очередь на обновление.
   *
   * Пустой ряд — ЗАКОННЫЙ результат (рассылку ещё не открывали): курсор всё равно двигаем,
   * иначе такая рассылка вечно занимала бы место в пачке обновления.
   */
  async function upsertRusenderCampaignActivity(channelId, campaignId, rows) {
    if (!enabled || !channelId || campaignId == null) return 0;
    const clean = (Array.isArray(rows) ? rows : []).filter((r) => r && r.day);
    return transaction(async (client) => {
      if (clean.length) {
        await client.query(
          `INSERT INTO rusender_campaign_activity (channel_id, campaign_id, day, opens, clicks, updated_at)
           SELECT $1, $2, x.day::date, COALESCE(x.opens, 0), COALESCE(x.clicks, 0), now()
             FROM jsonb_to_recordset($3::jsonb) AS x(day text, opens bigint, clicks bigint)
           ON CONFLICT (channel_id, campaign_id, day) DO UPDATE SET
             opens=EXCLUDED.opens, clicks=EXCLUDED.clicks, updated_at=now()`,
          [channelId, campaignId, JSON.stringify(clean)],
        );
      }
      await client.query(
        'UPDATE rusender_campaigns SET activity_synced_at=now() WHERE channel_id=$1 AND campaign_id=$2',
        [channelId, campaignId],
      );
      return clean.length;
    });
  }

  /**
   * Кого крон обновляет активностью в этом проходе. Порядок — «сначала живые и свежие, потом
   * самые давно не обновлявшиеся»: у только что отправленной рассылки открытия идут потоком,
   * у прошлогодней меняются раз в никогда, но и она обязана иногда доезжать (иначе её кривая
   * навсегда останется обрезанной первым сбором).
   *
   * Черновики (никогда не запускались) исключены: у них нет ни одного открытия по построению,
   * а запрос активности на них — сожжённая квота.
   */
  async function listRusenderCampaignsForActivity(channelId, { cap = ACTIVITY_REFRESH_CAP, freshDays = ACTIVITY_FRESH_DAYS } = {}) {
    if (!enabled || !channelId) return [];
    const limit = Math.max(1, Math.min(200, Number(cap) || ACTIVITY_REFRESH_CAP));
    const { rows } = await pool.query(
      `SELECT campaign_id
         FROM rusender_campaigns
        WHERE channel_id=$1
          AND (started_at IS NOT NULL OR status = ANY($2::text[]))
        ORDER BY
          -- Живые и свежие — вперёд, дальше по «кого дольше всех не трогали».
          (status = ANY($2::text[])
            OR (started_at IS NOT NULL AND started_at >= now() - ($3 || ' days')::interval)) DESC,
          activity_synced_at ASC NULLS FIRST,
          started_at DESC NULLS LAST
        LIMIT $4`,
      [channelId, LIVE_STATUSES, String(Math.max(1, Number(freshDays) || ACTIVITY_FRESH_DAYS)), limit],
    );
    return rows.map((r) => Number(r.campaign_id));
  }

  // ── Чтение (ForActor) ───────────────────────────────────────────────────────────────────────
  // Все ридеры проходят ownership-чек канала, даже когда роут уже резолвил канал: defense in
  // depth ровно по тем же соображениям, что и у CDEK/МС.

  /**
   * Итоги окна. Возвращает ДВЕ независимые группы (см. «две правды о времени» в шапке файла):
   *   events   — открытия/клики, СЛУЧИВШИЕСЯ в окне (дневная активность);
   *   campaigns— итоги рассылок, ЗАПУЩЕННЫХ в окне (кумулятивные счётчики кампаний).
   * Плюс contacts — последний снимок базы В ОКНЕ (не «сегодня»: у окна в прошлом честный ответ —
   * то, что база показывала тогда).
   */
  async function getRusenderSummaryInternal(channelId, { from = null, to = null, tz = 'Europe/Moscow' } = {}) {
    const { rows } = await pool.query(
      `WITH ev AS (
         SELECT COALESCE(SUM(opens), 0)::bigint AS opens, COALESCE(SUM(clicks), 0)::bigint AS clicks
           FROM rusender_campaign_activity
          WHERE channel_id=$1
            AND ($2::date IS NULL OR day >= $2::date)
            AND ($3::date IS NULL OR day <= $3::date)
       ), cm AS (
         SELECT COUNT(*)::bigint                       AS campaigns,
                COALESCE(SUM(total), 0)::bigint        AS total,
                COALESCE(SUM(delivered), 0)::bigint    AS delivered,
                COALESCE(SUM(opens), 0)::bigint        AS opens,
                COALESCE(SUM(clicks), 0)::bigint       AS clicks,
                COALESCE(SUM(errors), 0)::bigint       AS errors,
                COALESCE(SUM(unsubscribes), 0)::bigint AS unsubscribes,
                COALESCE(SUM(complaints), 0)::bigint   AS complaints
           FROM rusender_campaigns
          WHERE channel_id=$1
            AND started_at IS NOT NULL
            AND ($2::date IS NULL OR (started_at AT TIME ZONE $4)::date >= $2::date)
            AND ($3::date IS NULL OR (started_at AT TIME ZONE $4)::date <= $3::date)
       ), ct AS (
         SELECT contacts_total, contacts_active, contacts_unsubscribed, contacts_unavailable,
                to_char(day, 'YYYY-MM-DD') AS day
           FROM rusender_daily
          WHERE channel_id=$1
            AND contacts_total IS NOT NULL
            AND ($2::date IS NULL OR day >= $2::date)
            AND ($3::date IS NULL OR day <= $3::date)
          ORDER BY day DESC
          LIMIT 1
       )
       SELECT (SELECT row_to_json(ev) FROM ev) AS events,
              (SELECT row_to_json(cm) FROM cm) AS campaigns,
              (SELECT row_to_json(ct) FROM ct) AS contacts`,
      [channelId, from, to, tz],
    );
    const r = rows[0] || {};
    return {
      events: r.events || { opens: 0, clicks: 0 },
      campaigns: r.campaigns || {
        campaigns: 0, total: 0, delivered: 0, opens: 0, clicks: 0, errors: 0, unsubscribes: 0, complaints: 0,
      },
      contacts: r.contacts || null,
    };
  }

  /**
   * Дневные серии окна, ПЛОТНЫЕ: дни без активности дозаполняются честными нулями (иначе график
   * сжимает ось и провал читается как «данных нет»). База контактов, наоборот, дозаполняется
   * NULL'ами: день без снимка — это дыра в сборе, а не обнулившаяся база, и линия обязана в этом
   * месте разорваться, а не упасть в ноль.
   */
  async function getRusenderSeriesInternal(channelId, { from, to } = {}) {
    if (!from || !to) return [];
    const { rows } = await pool.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COALESCE(a.opens, 0)::bigint  AS opens,
              COALESCE(a.clicks, 0)::bigint AS clicks,
              rd.contacts_total, rd.contacts_active, rd.contacts_unsubscribed
         FROM generate_series($2::date, $3::date, '1 day') AS d(day)
         LEFT JOIN (
              SELECT day, SUM(opens) AS opens, SUM(clicks) AS clicks
                FROM rusender_campaign_activity
               WHERE channel_id=$1 AND day >= $2::date AND day <= $3::date
               GROUP BY day
         ) a ON a.day = d.day
         LEFT JOIN rusender_daily rd ON rd.channel_id=$1 AND rd.day = d.day
        ORDER BY d.day ASC`,
      [channelId, from, to],
    );
    return rows;
  }

  /** Лента рассылок окна, свежие сверху. status/q — необязательные фильтры ленты. */
  async function getRusenderCampaignsInternal(channelId, {
    from = null, to = null, tz = 'Europe/Moscow', status = null, q = null,
    includeArchived = false, limit = CAMPAIGNS_MAX_ROWS,
  } = {}) {
    const cap = Math.max(1, Math.min(CAMPAIGNS_MAX_ROWS, Number(limit) || CAMPAIGNS_MAX_ROWS));
    const statusList = Array.isArray(status) && status.length ? status.map(String) : null;
    const search = q && String(q).trim() ? `%${String(q).trim().toLowerCase()}%` : null;
    const { rows } = await pool.query(
      `SELECT campaign_id, name, subject, preview_title, type, status,
              sender_email, sender_name, list_names, is_archived,
              to_char(started_at AT TIME ZONE $4, 'YYYY-MM-DD"T"HH24:MI:SS')  AS started_at,
              to_char(finished_at AT TIME ZONE $4, 'YYYY-MM-DD"T"HH24:MI:SS') AS finished_at,
              to_char(scheduled_at AT TIME ZONE $4, 'YYYY-MM-DD"T"HH24:MI:SS') AS scheduled_at,
              total, sending, delivered, opens, clicks, errors, unsubscribes, complaints
         FROM rusender_campaigns
        WHERE channel_id=$1
          AND ($7::boolean IS TRUE OR is_archived = false)
          AND ($2::date IS NULL OR started_at IS NULL
               OR (started_at AT TIME ZONE $4)::date >= $2::date)
          AND ($3::date IS NULL OR started_at IS NULL
               OR (started_at AT TIME ZONE $4)::date <= $3::date)
          AND ($5::text[] IS NULL OR status = ANY($5::text[]))
          AND ($6::text IS NULL OR lower(COALESCE(name, '')) LIKE $6::text
                                OR lower(COALESCE(subject, '')) LIKE $6::text)
        ORDER BY started_at DESC NULLS LAST, campaign_id DESC
        LIMIT $8`,
      [channelId, from, to, tz, statusList, search, !!includeArchived, cap],
    );
    return rows;
  }

  /** Одна рассылка + её дневная кривая (архив активности), для разворота карточки. */
  async function getRusenderCampaignInternal(channelId, campaignId, { tz = 'Europe/Moscow' } = {}) {
    const id = Number(campaignId);
    if (!Number.isFinite(id)) return null;
    const { rows } = await pool.query(
      `SELECT campaign_id, name, subject, preview_title, type, status,
              sender_email, sender_name, list_names, is_archived,
              to_char(started_at AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI:SS')  AS started_at,
              to_char(finished_at AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI:SS') AS finished_at,
              to_char(scheduled_at AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI:SS') AS scheduled_at,
              to_char(activity_synced_at AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI:SS') AS activity_synced_at,
              total, sending, delivered, opens, clicks, errors, unsubscribes, complaints
         FROM rusender_campaigns
        WHERE channel_id=$1 AND campaign_id=$2`,
      [channelId, id, tz],
    );
    const campaign = rows[0] || null;
    if (!campaign) return null;
    const { rows: activity } = await pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, opens, clicks
         FROM rusender_campaign_activity
        WHERE channel_id=$1 AND campaign_id=$2
        ORDER BY day ASC`,
      [channelId, id],
    );
    return { campaign, activity };
  }

  /**
   * Границы архива для окна «Всё»: первый и последний день, о котором нам вообще что-то известно.
   * Берём МИНИМУМ по обеим семьям (активность и запуски рассылок) — иначе «Всё» обрезало бы
   * историю по той семье, что начала копиться позже.
   */
  async function getRusenderBoundsInternal(channelId, { tz = 'Europe/Moscow' } = {}) {
    const { rows } = await pool.query(
      `SELECT to_char(LEAST(a.first_day, c.first_day), 'YYYY-MM-DD') AS first_day,
              to_char(GREATEST(a.last_day, c.last_day), 'YYYY-MM-DD') AS last_day,
              COALESCE(c.campaigns, 0)::bigint AS campaigns
         FROM (SELECT MIN(day) AS first_day, MAX(day) AS last_day
                 FROM rusender_campaign_activity WHERE channel_id=$1) a
         CROSS JOIN (
              SELECT MIN((started_at AT TIME ZONE $2)::date) AS first_day,
                     MAX((started_at AT TIME ZONE $2)::date) AS last_day,
                     COUNT(*) AS campaigns
                FROM rusender_campaigns WHERE channel_id=$1 AND started_at IS NOT NULL) c`,
      [channelId, tz],
    );
    return rows[0] || { first_day: null, last_day: null, campaigns: 0 };
  }

  async function getRusenderSummaryForActor(channelId, actor, opts = {}) {
    return (await allowed(channelId, actor)) ? getRusenderSummaryInternal(channelId, opts) : null;
  }
  async function getRusenderSeriesForActor(channelId, actor, opts = {}) {
    return (await allowed(channelId, actor)) ? getRusenderSeriesInternal(channelId, opts) : [];
  }
  async function getRusenderCampaignsForActor(channelId, actor, opts = {}) {
    return (await allowed(channelId, actor)) ? getRusenderCampaignsInternal(channelId, opts) : [];
  }
  async function getRusenderCampaignForActor(channelId, actor, campaignId, opts = {}) {
    return (await allowed(channelId, actor)) ? getRusenderCampaignInternal(channelId, campaignId, opts) : null;
  }
  async function getRusenderBoundsForActor(channelId, actor, opts = {}) {
    return (await allowed(channelId, actor)) ? getRusenderBoundsInternal(channelId, opts) : null;
  }

  return {
    saveRusenderAccount,
    getRusenderAccount,
    listRusenderAccounts,
    deleteRusenderAccount,
    upsertRusenderDaily,
    upsertRusenderCampaigns,
    upsertRusenderCampaignActivity,
    listRusenderCampaignsForActivity,
    getRusenderSummaryForActor,
    getRusenderSeriesForActor,
    getRusenderCampaignsForActor,
    getRusenderCampaignForActor,
    getRusenderBoundsForActor,
    RUSENDER_CAMPAIGNS_MAX_ROWS: CAMPAIGNS_MAX_ROWS,
    RUSENDER_ACTIVITY_REFRESH_CAP: ACTIVITY_REFRESH_CAP,
  };
}

module.exports = {
  createRusenderRepo,
  CAMPAIGNS_MAX_ROWS,
  ACTIVITY_REFRESH_CAP,
  ACTIVITY_FRESH_DAYS,
  LIVE_STATUSES,
};
