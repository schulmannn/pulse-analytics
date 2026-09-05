// ═══════════════════════════════════════════════════════════════
//  Atlavue — GDPR service (стирание и экспорт аккаунта, F4/F5)
// ═══════════════════════════════════════════════════════════════
// СЕРВИС, не repo (спека распила db.js, PR 8): erasure/export пересекают ВСЕ домены
// (users/channels/reports/integrations/архивы) — как repo это стало бы новым мини-god-
// module. Deps: pool (экспорт держит ОДИН выделенный коннект), transaction (общий
// BEGIN/COMMIT/ROLLBACK-хелпер db/core), enabled.

'use strict';

// Экспорт СТРИМИТСЯ, а не буферизуется: архивы канала (daily/posts/mentions/velocity/…,
// до 730 дн × N каналов) целиком в один JS-объект = OOM веб-процесса (Fable-finding). Поэтому
// каждый архивный массив тянется keyset-страницами фиксированного размера и пишется в res
// по мере готовности — память ограничена одной страницей, не всем архивом. `workspaces`, memberships,
// reports, campaigns, AI, audit events, личные `mention_notify_subscriptions` и перечень `channels`
// тоже пагинируются keyset'ом: у этих наборов нет общего DB cap, а channels-цикл не должен опираться
// на продуктовый кап ради memory-proof. Буферизуются только singleton account/prefs/integrations.
// Размер страницы приходит из config через dep (services читают только внедрённые зависимости,
// не окружение — check:boundaries).
const EXPORT_PAGE_SIZE_DEFAULT = 1000;
// Потолок keyset-страницы (defense-in-depth): даже если в сервис прилетит гигантский pageSize
// (тестовый шов или ошибка вызывающего), одна страница не должна разрушить ограничение памяти.
// Держим в паре с config-валидатором GDPR_EXPORT_PAGE_SIZE (тот же диапазон 1..EXPORT_PAGE_SIZE_MAX).
const EXPORT_PAGE_SIZE_MAX = 1000;

// Нормализация размера страницы: целое в [1, EXPORT_PAGE_SIZE_MAX], иначе fallback. Гигантское
// значение зажимается к потолку (bounded memory), мусор/дробь/≤0 → fallback.
function clampPageSize(v, fallback) {
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(Math.floor(v), EXPORT_PAGE_SIZE_MAX);
}

// Клиент разорвал соединение посреди стрима: не ошибка сервера — прекращаем работу тихо, без
// повторной попытки ответа и без аудита завершения.
class ExportAborted extends Error {
  constructor() {
    super('export aborted by client');
    this.name = 'ExportAborted';
  }
}

// ── Keyset-спеки архивных массивов ───────────────────────────────────────────────────────────
// Каждый массив пагинируется по УНИКАЛЬНОМУ, детерминированному ключу (никакого OFFSET). cast —
// тип колонки в БД; курсор всегда передаётся как ::text-строка (алиас `col::text`) и в WHERE
// кастуется обратно к cast — это исключает потерю точности timestamptz (микросекунды) и tz-сдвиги
// DATE между Node и Postgres на границе страницы. Порядок сохраняет прежнюю ведущую сортировку и
// добавляет уникальный tie-breaker там, где ведущая колонка не уникальна (равные метки времени
// не должны ни дублировать, ни терять строки на стыке страниц). `cols` повторяет прежний SELECT,
// поэтому форма/набор полей строки в JSON не меняется; служебные `__cN`-алиасы вырезаются.
const ARCHIVE_SPECS = {
  daily: {
    from: 'channel_daily', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'day', cast: 'date' }], order: 'day ASC',
  },
  monthly: {
    from: 'channel_monthly', chanCol: 'channel_id',
    cols: 'month, subscribers_end, joins_sum, leaves_sum, views_sum, forwards_sum, reactions_sum, days_count',
    keys: [{ col: 'month', cast: 'date' }], order: 'month ASC',
  },
  posts: {
    from: 'posts', cols: '*', chanCol: 'channel_id',
    // date_published NULLABLE → ведущий ключ может быть null: keyset учитывает NULLS LAST.
    keys: [{ col: 'date_published', cast: 'timestamptz' }, { col: 'post_id', cast: 'bigint' }],
    order: 'date_published ASC, post_id ASC',
  },
  mentions: {
    from: 'mentions', cols: '*', chanCol: 'owner_channel_id',
    // msg_id один не уникален (один и тот же msg_id из разных источников channel_id) → tie-break.
    keys: [{ col: 'msg_id', cast: 'bigint' }, { col: 'channel_id', cast: 'bigint' }],
    order: 'msg_id ASC, channel_id ASC',
  },
  velocity: {
    from: 'velocity_daily', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'day', cast: 'date' }], order: 'day ASC',
  },
  annotations: {
    from: 'chart_annotations', chanCol: 'channel_id',
    // Прежний вывод — {day,label,created_at}; id тянем ТОЛЬКО как курсор-tie-break и вырезаем.
    cols: 'day, label, created_at',
    keys: [{ col: 'day', cast: 'date' }, { col: 'id', cast: 'integer' }],
    order: 'day ASC, id ASC',
  },
  msOrders: {
    from: 'ms_orders', chanCol: 'channel_id',
    cols: 'order_id, moment, sum_kopecks, state, agent_id, agent_name, updated_at, state_id, sales_channel_id, city',
    keys: [{ col: 'order_id', cast: 'text' }], order: 'order_id ASC',
  },
  msReturns: {
    from: 'ms_returns', chanCol: 'channel_id',
    cols: 'return_id, moment, sum_kopecks, agent_id, agent_name, updated_at',
    keys: [{ col: 'return_id', cast: 'text' }], order: 'return_id ASC',
  },
  msDaily: {
    from: 'ms_daily', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'day', cast: 'date' }], order: 'day ASC',
  },
  ymDaily: {
    from: 'ym_daily', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'day', cast: 'date' }], order: 'day ASC',
  },
  rawSnapshots: {
    from: 'raw_snapshots', cols: '*', chanCol: 'channel_id',
    // Один канал фиксирован WHERE'ом; day/source/kind вместе остаются уникальным keyset'ом.
    keys: [
      { col: 'day', cast: 'date' },
      { col: 'source', cast: 'text' },
      { col: 'kind', cast: 'text' },
    ],
    order: 'day ASC, source ASC, kind ASC',
  },
  igDaily: {
    from: 'ig_daily', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'day', cast: 'date' }], order: 'day ASC',
  },
  igMedia: {
    from: 'ig_media_daily', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'day', cast: 'date' }, { col: 'media_id', cast: 'text' }],
    order: 'day ASC, media_id ASC',
  },
  // ── СДЭК (миграция 038) ────────────────────────────────────────────────────────────────────
  // Экспорт обещает «все архивы», а знал только четыре источника из шести: выгрузки СДЭКа и
  // рассылки Rusender в файл не попадали вовсе (аудит #554, L-5).
  cdekImports: {
    from: 'cdek_imports', chanCol: 'channel_id',
    // file_bytes — СЫРОЙ загруженный файл (десятки мегабайт на канал). В экспорт не идёт: он и
    // так весь разложен по строкам ниже, а тащить бинарь в JSON — это не «данные о человеке».
    cols: `id, uploaded_by, filename, file_sha256, status, rows_total, rows_inserted,
           rows_updated, rows_rejected, rows_deleted, orders_total, period_from, period_to,
           rejected, warnings, error, created_at, finished_at`,
    keys: [{ col: 'id', cast: 'integer' }], order: 'id ASC',
  },
  cdekOrders: {
    from: 'cdek_orders', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'order_id', cast: 'text' }], order: 'order_id ASC',
  },
  cdekOrderItems: {
    from: 'cdek_order_items', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'order_id', cast: 'text' }, { col: 'product_id', cast: 'text' }],
    order: 'order_id ASC, product_id ASC',
  },
  cdekProducts: {
    from: 'cdek_products', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'product_id', cast: 'text' }], order: 'product_id ASC',
  },
  // ── Rusender (миграции 039, 040) ───────────────────────────────────────────────────────────
  rusenderDaily: {
    from: 'rusender_daily', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'day', cast: 'date' }], order: 'day ASC',
  },
  rusenderCampaigns: {
    from: 'rusender_campaigns', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'campaign_id', cast: 'bigint' }], order: 'campaign_id ASC',
  },
  rusenderCampaignActivity: {
    from: 'rusender_campaign_activity', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'campaign_id', cast: 'bigint' }, { col: 'day', cast: 'date' }],
    order: 'campaign_id ASC, day ASC',
  },
};

// "Строка строго ПОСЛЕ курсора" в порядке `ASC NULLS LAST` лексикографически по ключам.
// Дизъюнкция по i: (все ключи < i равны курсору) AND (ключ i «после» курсора). Для ASC NULLS LAST
// «col после c»: c не null → (col IS NULL OR col > c) (null-строки идут после любого не-null c);
// c null → false (после null ничего нет) — такой дизъюнкт целиком выпадает, а более глубокие
// используют `col IS NULL` как равенство. nulls[i] — является ли значение курсора для ключа i null.
// Плейсхолдер получает ТОЛЬКО не-null ключ (null-значение сравнивается через `col IS NULL`, а не
// биндится параметром): плотная нумерация от `start` гарантирует, что каждый переданный параметр
// реально упомянут в SQL. Иначе PG не смог бы вывести тип «висящего» $n (bind supplies N params…)
// и запрос упал бы на строке с null в ведущем ключе (posts.date_published).
function buildKeysetPredicate(keys, nulls, start) {
  let next = start;
  const idx = keys.map((_, i) => (nulls[i] ? null : next++));
  const terms = [];
  for (let i = 0; i < keys.length; i++) {
    if (nulls[i]) continue; // «после null» = false → весь этот дизъюнкт ложен, пропускаем
    const parts = [];
    for (let j = 0; j < i; j++) {
      parts.push(nulls[j]
        ? `${keys[j].col} IS NULL`
        : `${keys[j].col} = $${idx[j]}::${keys[j].cast}`);
    }
    parts.push(`(${keys[i].col} IS NULL OR ${keys[i].col} > $${idx[i]}::${keys[i].cast})`);
    terms.push(`(${parts.join(' AND ')})`);
  }
  return terms.join(' OR ');
}

// Текст одной keyset-страницы. Параметры: $1 = id канала; при наличии курсора $2.. — его НЕ-null
// значения (::text) в порядке ключей (null-ключи параметра не занимают — см. buildKeysetPredicate);
// последний параметр — LIMIT. Курсорные колонки алиасятся `col::text AS __cN`, чтобы следующая
// страница получила точный, tz-независимый курсор.
function pageQuery(spec, hasCursor, nulls) {
  const aliases = spec.keys.map((k, i) => `, ${k.col}::text AS __c${i}`).join('');
  const sel = `SELECT ${spec.cols}${aliases} FROM ${spec.from}`;
  let where = `${spec.chanCol} = $1`;
  let limitIdx = 2;
  if (hasCursor) {
    where += ` AND (${buildKeysetPredicate(spec.keys, nulls, 2)})`;
    // LIMIT идёт сразу за биндами курсора; их ровно столько, сколько НЕ-null ключей.
    limitIdx = 2 + nulls.filter((n) => !n).length;
  }
  return `${sel} WHERE ${where} ORDER BY ${spec.order} LIMIT $${limitIdx}`;
}

// Строка → JSON-объект прежней формы: убираем служебные курсор-алиасы (__cN идут последними в
// SELECT, поэтому порядок реальных колонок сохраняется).
function projectRow(spec, row) {
  const out = {};
  for (const key of Object.keys(row)) {
    if (key.startsWith('__c')) continue;
    out[key] = row[key];
  }
  return out;
}

// Обёртка над res с поддержкой backpressure и обрыва соединения. write() ждёт 'drain', когда
// буфер полон, и отклоняется ExportAborted при close/error — так стрим не пишет в мёртвый сокет и
// не зависает в ожидании 'drain', который уже не придёт.
function createWriter(res) {
  let closed = false;
  let drainWaiters = [];
  const flush = (rejectAll) => {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const w of waiters) rejectAll ? w.reject(new ExportAborted()) : w.resolve();
  };
  const onClose = () => { closed = true; flush(true); };
  const onDrain = () => flush(false);
  res.on('close', onClose);
  res.on('error', onClose);
  res.on('drain', onDrain);
  return {
    get closed() { return closed; },
    async write(str) {
      if (closed) throw new ExportAborted();
      if (res.write(str)) return;
      await new Promise((resolve, reject) => drainWaiters.push({ resolve, reject }));
    },
    // Завершение ответа. Резолвится, когда res честно дописан ('finish'-callback res.end), и
    // отклоняется ExportAborted, если сокет оборвался ('close'/'error') ПОСЛЕ вызова res.end, но до
    // его callback'а — иначе Promise завис бы навсегда. Локальные слушатели снимаются при первом
    // исходе, повторный исход невозможен (guard `done`).
    end() {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new ExportAborted());
        if (res.writableEnded) return resolve();
        let done = false;
        const finish = (fn, arg) => {
          if (done) return;
          done = true;
          res.off('close', onAbort);
          res.off('error', onAbort);
          fn(arg);
        };
        const onAbort = () => finish(reject, new ExportAborted());
        res.on('close', onAbort);
        res.on('error', onAbort);
        res.end(() => finish(resolve));
      });
    },
    cleanup() {
      res.off('close', onClose);
      res.off('error', onClose);
      res.off('drain', onDrain);
    },
  };
}

// `{"a":1,"b":2` (без закрывающей `}`, с хвостовой запятой) — чтобы дописать в объект новые ключи
// стримом. Пустой объект → просто `{`.
function objectPrefix(obj) {
  const s = JSON.stringify(obj);
  return s === '{}' ? '{' : `${s.slice(0, -1)},`;
}

function createGdprService({ pool, enabled, transaction, exportPageSize }) {
  const defaultPageSize = clampPageSize(exportPageSize, EXPORT_PAGE_SIZE_DEFAULT);
  /* Полное стирание аккаунта (GDPR erasure) — один DELETE FROM users: реляционную полноту даёт
     схема. Каскадом умирают user_prefs / tg_sessions / email_tokens / reports / workspaces
     (+members/campaigns/posts) / ai_chats / ai_usage_daily / channels(owner_uid), а от channels —
     все архивы и подключения (channel_daily / monthly / posts / mentions / velocity / raw_snapshots /
     ig_* / ms_* / ym_* / api_keys / annotations / snapshots). audit_events.uid и
     chart_annotations.created_by → SET NULL
     (журнал остаётся, но анонимный). Разделяемые external_sources НЕ трогаются — это identity
     публичного канала, не персональные данные.
     Pre-null: канал ДРУГОГО владельца, живущий в воркспейсе стираемого юзера (инвариант «канал
     в личном воркспейсе создателя» кодом не enforced), переводится в legacy NULL-workspace —
     owner_uid-fallback чтения жив с миграции 010; иначе NO ACTION FK на channels.workspace_id
     валит весь DELETE. */
  async function deleteUserAccount(uid) {
    if (!enabled || uid == null) return false;
    return transaction(async (client) => {
      // У foreign-owned канала, ошибочно припаркованного в dying workspace, может быть
      // campaign_posts composite-FK (channel_id, workspace_id) с default ON UPDATE NO ACTION.
      // Следующий pre-null тогда заблокирован. Эти membership-строки всё равно исчезнут вместе с
      // workspace/campaign через несколько запросов; удаляем узко только ссылки на такие каналы.
      await client.query(
        `DELETE FROM campaign_posts cp
          USING channels c
          WHERE cp.channel_id = c.id
            AND cp.workspace_id = c.workspace_id
            AND c.workspace_id IN (SELECT id FROM workspaces WHERE owner_uid = $1)
            AND c.owner_uid IS DISTINCT FROM $1`,
        [uid]);
      await client.query(
        `UPDATE channels SET workspace_id = NULL
          WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_uid = $1)
            AND owner_uid IS DISTINCT FROM $1`, [uid]);
      // FK SET NULL анонимизирует только uid. Исторические metadata несут прямые идентификаторы,
      // ip_hash — стабильный HMAC и request_id — коррелируемый идентификатор запроса; после erasure
      // журнал вправду анонимный только если зачистить все три до удаления пользователя.
      await client.query(
        `UPDATE audit_events
            SET metadata = '{}'::jsonb, ip_hash = NULL, request_id = NULL
          WHERE uid = $1`,
        [uid]);
      // Приглашения хранят email СТРОКОЙ и живут в ЧУЖИХ воркспейсах: каскад по users их не
      // трогает, и после «стирания» адрес человека оставался в базе у всех, кто его звал.
      // Читаем email до DELETE — после него строки users уже нет.
      const { rows: victim } = await client.query('SELECT email FROM users WHERE id = $1', [uid]);
      if (victim[0]) {
        await client.query('DELETE FROM workspace_invites WHERE lower(email) = lower($1)', [victim[0].email]);
      }
      const { rowCount } = await client.query('DELETE FROM users WHERE id = $1', [uid]);
      // Осиротевшие external_sources: для приватного канала username/title (часто имя человека)
      // не «shared identity» — если после каскада на источник не ссылается НИКТО, стираем и его.
      // Разделяемые источники (чужие channels/архивы ссылаются) переживают sweep невредимыми.
      await client.query(
        `DELETE FROM external_sources s
          WHERE NOT EXISTS (SELECT 1 FROM channels        t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ig_accounts     t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ms_accounts     t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ym_accounts     t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM channel_daily   t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM channel_monthly t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM posts           t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM velocity_daily  t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM mentions        t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ig_daily        t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ig_media_daily  t WHERE t.source_id = s.id)
            -- Свип не знал про cdek_sources и rusender_accounts: их FK на external_sources идут
            -- БЕЗ ON DELETE, поэтому стирание одного пользователя пыталось снести источник,
            -- на который ссылается канал СОСЕДНЕГО tenant'а (аудит #554, L-5).
            AND NOT EXISTS (SELECT 1 FROM cdek_sources      t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM rusender_accounts t WHERE t.source_id = s.id)`);
      return rowCount > 0;
    });
  }

  // Один архивный массив: keyset-страницами тянем строки и пишем `[row,row,…]` прямо в res.
  // Память ограничена одной страницей (её JSON собирается в буфер и пишется одним chunk'ом с учётом
  // backpressure). Курсор следующей страницы = ::text-значения ключей последней строки.
  async function streamArchive(w, client, spec, chanId, PAGE) {
    await w.write('[');
    let cursor = null;
    let nulls = null;
    let first = true;
    for (;;) {
      if (w.closed) throw new ExportAborted(); // клиент ушёл — дальше в БД не ходим
      const text = pageQuery(spec, cursor != null, nulls);
      // null-ключи параметра не занимают (см. buildKeysetPredicate) → передаём только не-null, чтобы
      // порядок биндов совпал с плейсхолдерами и не осталось «висящего» $n без типа.
      const params = cursor ? [chanId, ...cursor.filter((v) => v != null), PAGE] : [chanId, PAGE];
      const { rows } = await client.query(text, params);
      if (rows.length === 0) break;
      let buf = '';
      for (const row of rows) {
        buf += (first ? '' : ',') + JSON.stringify(projectRow(spec, row));
        first = false;
      }
      await w.write(buf);
      if (rows.length < PAGE) break;
      const last = rows[rows.length - 1];
      cursor = spec.keys.map((_, i) => last[`__c${i}`]);
      nulls = cursor.map((v) => v == null);
    }
    await w.write(']');
  }

  // Верхнеуровневый массив, принадлежащий юзеру и пагинируемый по уникальному id-keyset'у (no OFFSET,
  // no unbounded aggregate over the whole set). Workspaces/reports не имеют общего DB cap на
  // владельца, поэтому «прочитать все и JSON.stringify» — та же OOM-угроза, что и архив.
  // Форма/порядок строк = прежний `ORDER BY id`, память ограничена одной страницей. `cols` — тот же
  // SELECT, что раньше (форма JSON не меняется).
  async function streamOwnedById(w, q, from, ownerCol, cols, ownerId, PAGE) {
    await w.write('[');
    let cursor = null;
    let first = true;
    for (;;) {
      if (w.closed) throw new ExportAborted();
      const sql = `SELECT ${cols} FROM ${from} WHERE ${ownerCol}=$1`
        + (cursor != null ? ' AND id > $2' : '')
        + ` ORDER BY id ASC LIMIT $${cursor != null ? 3 : 2}`;
      const params = cursor != null ? [ownerId, cursor, PAGE] : [ownerId, PAGE];
      const { rows } = await q(sql, params);
      if (rows.length === 0) break;
      let buf = '';
      for (const row of rows) { buf += (first ? '' : ',') + JSON.stringify(row); first = false; }
      await w.write(buf);
      if (rows.length < PAGE) break;
      cursor = rows[rows.length - 1].id;
    }
    await w.write(']');
  }

  // Подписки принадлежат пользователю, а не владельцу канала: участник team-workspace вправе
  // подписаться на общий канал через собственную managed-сессию. Поэтому их нельзя собирать
  // внутри цикла только по owner_uid-каналам. Стримим все строки uid по уникальному channel_id
  // keyset'ом. Намеренно НЕ JOIN'им channels и не экспортируем title/username/rules/archive:
  // собственная строка подписки переносима, чужие данные канала — нет.
  async function streamMentionNotifySubscriptions(w, q, uid, PAGE) {
    await w.write('[');
    let cursor = null;
    let first = true;
    for (;;) {
      if (w.closed) throw new ExportAborted();
      const sql = `SELECT channel_id, enabled, send_days, send_hour, last_run_at,
                          last_notified_at, last_error, created_at, updated_at
                     FROM mention_notify_subscriptions
                    WHERE uid=$1`
        + (cursor != null ? ' AND channel_id > $2' : '')
        + ` ORDER BY channel_id ASC LIMIT $${cursor != null ? 3 : 2}`;
      const params = cursor != null ? [uid, cursor, PAGE] : [uid, PAGE];
      const { rows } = await q(sql, params);
      if (rows.length === 0) break;
      let buf = '';
      for (const row of rows) {
        buf += (first ? '' : ',') + JSON.stringify(row);
        first = false;
      }
      await w.write(buf);
      if (rows.length < PAGE) break;
      cursor = rows[rows.length - 1].channel_id;
    }
    await w.write(']');
  }

  // Сообщения принадлежат юзеру через ai_chats, поэтому ownership проверяется JOIN'ом, а не
  // доверенным chat_id. Глобальный message.id — уникальный детерминированный keyset.
  async function streamAiMessages(w, q, uid, PAGE) {
    await w.write('[');
    let cursor = null;
    let first = true;
    for (;;) {
      if (w.closed) throw new ExportAborted();
      const sql = `SELECT m.id, m.chat_id, m.role, m.content, m.tool_trace, m.model,
                          m.input_tokens, m.output_tokens, m.error, m.created_at
                     FROM ai_chat_messages m
                     JOIN ai_chats c ON c.id = m.chat_id
                    WHERE c.user_id=$1`
        + (cursor != null ? ' AND m.id > $2' : '')
        + ` ORDER BY m.id ASC LIMIT $${cursor != null ? 3 : 2}`;
      const params = cursor != null ? [uid, cursor, PAGE] : [uid, PAGE];
      const { rows } = await q(sql, params);
      if (rows.length === 0) break;
      let buf = '';
      for (const row of rows) {
        buf += (first ? '' : ',') + JSON.stringify(row);
        first = false;
      }
      await w.write(buf);
      if (rows.length < PAGE) break;
      cursor = rows[rows.length - 1].id;
    }
    await w.write(']');
  }

  // ai_usage_daily не имеет surrogate id: (user_id, day) — PK, а фиксированный user_id оставляет
  // уникальный DATE-keyset. day::text сохраняет курсор без timezone-преобразования Node.
  async function streamAiUsageDaily(w, q, uid, PAGE) {
    await w.write('[');
    let cursor = null;
    let first = true;
    for (;;) {
      if (w.closed) throw new ExportAborted();
      const sql = `SELECT day, messages, input_tokens, output_tokens, day::text AS __cursor
                     FROM ai_usage_daily WHERE user_id=$1`
        + (cursor != null ? ' AND day > $2::date' : '')
        + ` ORDER BY day ASC LIMIT $${cursor != null ? 3 : 2}`;
      const params = cursor != null ? [uid, cursor, PAGE] : [uid, PAGE];
      const { rows } = await q(sql, params);
      if (rows.length === 0) break;
      let buf = '';
      for (const row of rows) {
        const { __cursor, ...portable } = row;
        buf += (first ? '' : ',') + JSON.stringify(portable);
        first = false;
      }
      await w.write(buf);
      if (rows.length < PAGE) break;
      cursor = rows[rows.length - 1].__cursor;
    }
    await w.write(']');
  }

  // Только СОБСТВЕННЫЕ membership-строки пользователя. Нельзя вкладывать весь roster в owned
  // workspaces: uid/roles коллег — персональные данные коллег. kind нужен для переноса семантики
  // personal/team; owner/name чужого workspace намеренно не раскрываются.
  async function streamWorkspaceMemberships(w, q, uid, PAGE) {
    await w.write('[');
    let cursor = null;
    let first = true;
    for (;;) {
      if (w.closed) throw new ExportAborted();
      const sql = `SELECT m.workspace_id, m.role, m.created_at, w.kind AS workspace_kind
                     FROM workspace_members m
                     JOIN workspaces w ON w.id = m.workspace_id
                    WHERE m.uid=$1`
        + (cursor != null ? ' AND m.workspace_id > $2' : '')
        + ` ORDER BY m.workspace_id ASC LIMIT $${cursor != null ? 3 : 2}`;
      const params = cursor != null ? [uid, cursor, PAGE] : [uid, PAGE];
      const { rows } = await q(sql, params);
      if (rows.length === 0) break;
      let buf = '';
      for (const row of rows) {
        buf += (first ? '' : ',') + JSON.stringify(row);
        first = false;
      }
      await w.write(buf);
      if (rows.length < PAGE) break;
      cursor = rows[rows.length - 1].workspace_id;
    }
    await w.write(']');
  }

  // Кампания переносима только когда пользователь сам её создал И всё ещё читает workspace.
  // Это не даёт старому created_by превратиться в обход текущей tenant-границы после исключения.
  async function streamOwnedAccessibleCampaigns(w, q, uid, PAGE) {
    await w.write('[');
    let cursor = null;
    let first = true;
    for (;;) {
      if (w.closed) throw new ExportAborted();
      const sql = `SELECT c.id, c.workspace_id, c.name, c.description, c.color, c.status,
                          c.start_date, c.end_date, c.created_at, c.updated_at
                     FROM campaigns c
                     JOIN workspaces w ON w.id = c.workspace_id
                    WHERE c.created_by=$1
                      AND (w.owner_uid=$1 OR EXISTS (
                        SELECT 1 FROM workspace_members m
                         WHERE m.workspace_id=c.workspace_id AND m.uid=$1
                      ))`
        + (cursor != null ? ' AND c.id > $2' : '')
        + ` ORDER BY c.id ASC LIMIT $${cursor != null ? 3 : 2}`;
      const params = cursor != null ? [uid, cursor, PAGE] : [uid, PAGE];
      const { rows } = await q(sql, params);
      if (rows.length === 0) break;
      let buf = '';
      for (const row of rows) {
        buf += (first ? '' : ',') + JSON.stringify(row);
        first = false;
      }
      await w.write(buf);
      if (rows.length < PAGE) break;
      cursor = rows[rows.length - 1].id;
    }
    await w.write(']');
  }

  // Только membership-строки, которые добавил сам пользователь, и только пока у него есть текущий
  // доступ к workspace кампании. Caption/published_at/media_type могут быть контентом коллег или
  // shared source — safe projection оставляет лишь identity собственной операции + added_at.
  // Составной PK даёт bounded keyset.
  async function streamOwnedAccessibleCampaignPosts(w, q, uid, PAGE) {
    await w.write('[');
    let cursor = null;
    let first = true;
    for (;;) {
      if (w.closed) throw new ExportAborted();
      const cursorAliases = `, cp.campaign_id::text AS __c0, cp.network::text AS __c1,
                                cp.channel_id::text AS __c2, cp.post_ref::text AS __c3`;
      const sql = `SELECT cp.campaign_id, cp.network, cp.channel_id, cp.post_ref, cp.added_at${cursorAliases}
                     FROM campaign_posts cp
                     JOIN campaigns c ON c.id = cp.campaign_id
                     JOIN workspaces w ON w.id = c.workspace_id
                    WHERE cp.added_by=$1
                      AND (w.owner_uid=$1 OR EXISTS (
                        SELECT 1 FROM workspace_members m
                         WHERE m.workspace_id=c.workspace_id AND m.uid=$1
                      ))`
        + (cursor != null
          ? ` AND (cp.campaign_id, cp.network, cp.channel_id, cp.post_ref)
                    > ($2::integer, $3::text, $4::integer, $5::text)`
          : '')
        + ` ORDER BY cp.campaign_id ASC, cp.network ASC, cp.channel_id ASC, cp.post_ref ASC
            LIMIT $${cursor != null ? 6 : 2}`;
      const params = cursor != null ? [uid, ...cursor, PAGE] : [uid, PAGE];
      const { rows } = await q(sql, params);
      if (rows.length === 0) break;
      let buf = '';
      for (const row of rows) {
        const portable = {};
        for (const key of Object.keys(row)) {
          if (!key.startsWith('__c')) portable[key] = row[key];
        }
        buf += (first ? '' : ',') + JSON.stringify(portable);
        first = false;
      }
      await w.write(buf);
      if (rows.length < PAGE) break;
      const last = rows[rows.length - 1];
      cursor = [last.__c0, last.__c1, last.__c2, last.__c3];
    }
    await w.write(']');
  }

  /* Экспорт персональных данных (GDPR portability) — один JSON-файл, СТРИМОМ (см. шапку модуля).
     Учётные данные не экспортируются НИКОГДА: pass_hash, token_version, tg_sessions.session_enc,
     ig_accounts.access_token_enc, ms_accounts.access_token_enc, ym_accounts.access_token_enc,
     tg_notify_bindings.link_token_hash и api_keys.key_hash не попадают в SELECT'ы. Каналы —
     только owner_uid=uid:
     шаренные воркспейс-каналы принадлежат другому владельцу (data minimization).
     Один выделенный клиент = ровно один коннект (как раньше): фан-аут через pool.query душил бы
     весь API на время экспорта. Клиент освобождается в finally — на успехе, ошибке И обрыве.
     Возвращает: 'not_found' (юзера нет — байты НЕ писались, роут отдаёт 404), 'ok' (документ
     дописан и res закрыт — роут аудитит), 'aborted' (клиент отвалился), 'stream_error' (сбой
     после начала ответа — res уничтожен, второй JSON-ответ невозможен). Ошибка ДО первого байта
     (напр. упал account-запрос) — throw, роут уводит в next(err) со штатным 500. */
  async function streamUserExport(uid, res, { onReady, pageSize } = {}) {
    if (!enabled || uid == null) return 'not_found';
    // Per-call override — тестовый шов для сужения страницы; прод-роут его не передаёт. Гигантский
    // override зажимается к потолку (bounded memory), мусор → defaultPageSize.
    const PAGE = clampPageSize(pageSize, defaultPageSize);
    const client = await pool.connect();
    const w = createWriter(res);
    let started = false;
    try {
      const q = (sql, params) => client.query(sql, params);

      // ── Заголовок документа: буферизуем только singleton-строки account/prefs/tg-session.
      //    Workspaces/reports/channels идут id-keyset'ом ниже. ──
      const account = (await q(
        `SELECT id, email, role, status, avatar_url, created_at FROM users WHERE id=$1`, [uid])).rows[0] || null;
      if (!account) return 'not_found'; // ни одного байта не записано → роут отдаст чистый 404

      const prefsRow = (await q(`SELECT prefs, updated_at FROM user_prefs WHERE uid=$1`, [uid])).rows[0] || null;
      const tgSession = (await q(
        `SELECT tg_user_id, username, connected_at, updated_at, connection_state,
                last_attempt_at, last_success_at, last_error_code, last_error_at
           FROM tg_sessions WHERE uid=$1`, [uid])).rows[0] || null;
      // Привязка бота уведомлений (035) — singleton по uid, как tg-сессия: chat_id/tg_user_id/
      // username это персональные данные, и стирание их каскадит, поэтому экспорт обязан их
      // показывать. link_token_hash (и его срок) — bearer-хеш привязки, credential: НЕ экспортируем.
      const tgNotifyBinding = (await q(
        `SELECT chat_id, tg_user_id, username, bound_at, created_at, updated_at
           FROM tg_notify_bindings WHERE uid=$1`, [uid])).rows[0] || null;

      // ── С этого момента полетели байты: 404/next(err) уже недоступны ──
      if (onReady) onReady();
      started = true;

      await w.write('{');
      await w.write(`"format":${JSON.stringify('atlavue-export')},`);
      await w.write(`"version":1,`);
      await w.write(`"exported_at":${JSON.stringify(new Date().toISOString())},`);
      await w.write(`"account":${JSON.stringify(account)},`);
      await w.write(`"prefs":${JSON.stringify(prefsRow ? prefsRow.prefs : null)},`);
      // Partial unique ограничивает только personal workspace; будущих team-workspaces у владельца
      // schema разрешает несколько, поэтому весь набор тоже page'им. Чужой roster сюда не входит:
      // собственные membership-строки (включая shared workspaces) идут отдельным массивом ниже.
      await w.write('"workspaces":');
      await streamOwnedById(w, q, 'workspaces w', 'w.owner_uid',
        'w.id, w.name, w.kind, w.created_at', uid, PAGE);
      await w.write(',"workspace_memberships":');
      await streamWorkspaceMemberships(w, q, uid, PAGE);
      await w.write(',');
      // reports — id-keyset'ом (нет пер-юзер капа); форма/порядок строк прежние.
      await w.write(`"reports":`);
      await streamOwnedById(w, q, 'reports', 'uid',
        'id, name, config, schedule, created_at, updated_at, last_sent_at', uid, PAGE);
      await w.write(',"campaigns":');
      await streamOwnedAccessibleCampaigns(w, q, uid, PAGE);
      await w.write(',"campaign_posts":');
      await streamOwnedAccessibleCampaignPosts(w, q, uid, PAGE);
      await w.write(',"audit_events":');
      await streamOwnedById(w, q, 'audit_events', 'uid',
        'id, channel_id, action, created_at', uid, PAGE);
      await w.write(',');
      // Личные AI-диалоги — отдельные нормализованные массивы: сохраняют chat_id-связь и легко
      // переносятся, но ни один массив не собирается целиком в памяти.
      await w.write('"ai_chats":');
      await streamOwnedById(w, q, 'ai_chats', 'user_id',
        'id, title, created_at, updated_at', uid, PAGE);
      await w.write(',"ai_chat_messages":');
      await streamAiMessages(w, q, uid, PAGE);
      await w.write(',"ai_usage_daily":');
      await streamAiUsageDaily(w, q, uid, PAGE);
      await w.write(',');
      // Присутствие подключения — да; сама сессия — никогда (это credential, не данные).
      await w.write(`"telegram_session":${JSON.stringify(tgSession)},`);
      await w.write(`"telegram_notify_binding":${JSON.stringify(tgNotifyBinding)},`);
      // Личные подписки живут на uid и могут указывать на доступный team-канал другого owner.
      // Экспортируем их отдельно от owner-only channels, без JOIN/данных самого канала.
      await w.write('"mention_notify_subscriptions":');
      await streamMentionNotifySubscriptions(w, q, uid, PAGE);
      await w.write(',');
      await w.write(`"channels":[`);

      // Каналы тоже id-keyset'ом: перечень не опирается на продуктовый кап ради memory-proof, а
      // каждый канал сразу стримит свои архивы. Форма/порядок = прежний `ORDER BY id`.
      let chCursor = null;
      let firstChannel = true;
      for (;;) {
        if (w.closed) throw new ExportAborted();
        const chSql = `SELECT id, workspace_id, username, title, status, source, tg_channel_id, created_at
                FROM channels WHERE owner_uid=$1`
          + (chCursor != null ? ' AND id > $2' : '')
          + ` ORDER BY id ASC LIMIT $${chCursor != null ? 3 : 2}`;
        const chParams = chCursor != null ? [uid, chCursor, PAGE] : [uid, PAGE];
        const chRows = (await q(chSql, chParams)).rows;
        if (chRows.length === 0) break;
        for (const ch of chRows) {
          if (!firstChannel) await w.write(',');
          firstChannel = false;
          await w.write(objectPrefix({
            id: ch.id, workspace_id: ch.workspace_id, username: ch.username, title: ch.title,
            status: ch.status, source: ch.source,
            tg_channel_id: ch.tg_channel_id, created_at: ch.created_at,
          }));

          await w.write('"archive":{');
          await w.write('"daily":'); await streamArchive(w, client, ARCHIVE_SPECS.daily, ch.id, PAGE);
          await w.write(',"monthly":'); await streamArchive(w, client, ARCHIVE_SPECS.monthly, ch.id, PAGE);
          await w.write(',"posts":'); await streamArchive(w, client, ARCHIVE_SPECS.posts, ch.id, PAGE);
          await w.write(',"mentions":'); await streamArchive(w, client, ARCHIVE_SPECS.mentions, ch.id, PAGE);
          await w.write(',"velocity":'); await streamArchive(w, client, ARCHIVE_SPECS.velocity, ch.id, PAGE);
          await w.write(',"annotations":'); await streamArchive(w, client, ARCHIVE_SPECS.annotations, ch.id, PAGE);
          await w.write(',"ms_daily":'); await streamArchive(w, client, ARCHIVE_SPECS.msDaily, ch.id, PAGE);
          await w.write(',"ms_orders":'); await streamArchive(w, client, ARCHIVE_SPECS.msOrders, ch.id, PAGE);
          await w.write(',"ms_returns":'); await streamArchive(w, client, ARCHIVE_SPECS.msReturns, ch.id, PAGE);
          // Архив Метрики живёт после disconnect ym_accounts, поэтому входит в общий архив
          // независимо от текущего наличия singleton-подключения ниже.
          await w.write(',"ym_daily":'); await streamArchive(w, client, ARCHIVE_SPECS.ymDaily, ch.id, PAGE);
          // Сырые provider-снимки — самостоятельный переносимый архив, а не часть текущего
          // integration singleton. Скоуп только по owner-only channel_id.
          await w.write(',"raw_snapshots":'); await streamArchive(w, client, ARCHIVE_SPECS.rawSnapshots, ch.id, PAGE);
          // СДЭК и Rusender — те же архивы канала, что и остальные четыре источника. До этой
          // правки экспорт обещал «все архивы», а знал четыре из шести (аудит #554, L-5).
          // Пишутся безусловно, как ms_*/ym_*: пустой массив у канала другого источника честнее
          // отсутствующего ключа — читатель файла видит, что раздел есть и он пуст.
          await w.write(',"cdek_imports":'); await streamArchive(w, client, ARCHIVE_SPECS.cdekImports, ch.id, PAGE);
          await w.write(',"cdek_orders":'); await streamArchive(w, client, ARCHIVE_SPECS.cdekOrders, ch.id, PAGE);
          await w.write(',"cdek_order_items":'); await streamArchive(w, client, ARCHIVE_SPECS.cdekOrderItems, ch.id, PAGE);
          await w.write(',"cdek_products":'); await streamArchive(w, client, ARCHIVE_SPECS.cdekProducts, ch.id, PAGE);
          await w.write(',"rusender_daily":'); await streamArchive(w, client, ARCHIVE_SPECS.rusenderDaily, ch.id, PAGE);
          await w.write(',"rusender_campaigns":'); await streamArchive(w, client, ARCHIVE_SPECS.rusenderCampaigns, ch.id, PAGE);
          await w.write(',"rusender_campaign_activity":'); await streamArchive(w, client, ARCHIVE_SPECS.rusenderCampaignActivity, ch.id, PAGE);
          await w.write('}'); // /archive

          // Текущий collector snapshot содержит тяжёлую data: URL фотографии канала. Фото уже
          // публичная identity и не нужно для переносимости аналитики; вырезаем только этот ключ,
          // остальные snapshot-поля сохраняем.
          const snapshot = (await q(
            `SELECT data - 'channel_photo' AS data, updated_at
               FROM channel_snapshots WHERE channel_id=$1`, [ch.id])).rows[0] || null;
          await w.write(`,"snapshot":${JSON.stringify(snapshot)}`);

          const mentionSettings = (await q(
            `SELECT include_terms, exclude_terms, exclude_sources, match_mode, updated_at
               FROM channel_mention_settings WHERE channel_id=$1`, [ch.id])).rows[0] || null;
          await w.write(`,"mention_settings":${JSON.stringify(mentionSettings)}`);

          // Личная подписка на уведомления об упоминаниях (035/036) — singleton по (channel, uid),
          // поэтому буферизуется, как и остальные одиночные строки. Скоуп по uid обязателен: у
          // одного канала подписки нескольких участников, чужая — не данные экспортируемого.
          const mentionNotify = (await q(
            `SELECT enabled, send_days, send_hour, last_run_at, last_notified_at, last_error,
                    created_at, updated_at
               FROM mention_notify_subscriptions WHERE channel_id=$1 AND uid=$2`, [ch.id, uid])).rows[0] || null;
          await w.write(`,"mention_notify_subscription":${JSON.stringify(mentionNotify)}`);

          // Идентичность подключённого счётчика Метрики (033) — singleton по каналу. Симметрия со
          // стиранием: строка каскадит вместе с каналом, значит обязана быть и в экспорте.
          // access_token_enc — credential, в SELECT его нет по построению (как у ig_accounts).
          const ym = (await q(
            `SELECT counter_id, counter_name, site, counter_created_day, connected_at, updated_at
               FROM ym_accounts WHERE channel_id=$1`, [ch.id])).rows[0] || null;
          await w.write(`,"yandex_metrika":${JSON.stringify(ym)}`);

          // Safe metadata подключения МойСклада; access_token_enc не выбран. Архив ms_daily
          // находится выше независимо от текущего подключения и переживает disconnect.
          const ms = (await q(
            `SELECT ms_account_id, org_name, connected_at, updated_at
               FROM ms_accounts WHERE channel_id=$1`, [ch.id])).rows[0] || null;
          await w.write(`,"moysklad":${JSON.stringify(ms)}`);

          // Идентичность источника СДЭКа (038) — singleton по каналу, как у Метрики и склада.
          // Секретов у него нет вовсе: подключение — это склад и часовой пояс, по которым потом
          // читается загруженный файл. Архив cdek_* уже уезжает выше; без этих трёх полей экспорт
          // не отвечал на вопрос «а что у вас про МЕНЯ подключено» (аудит #554, проход №2, N17).
          const cdek = (await q(
            `SELECT warehouse_code, tz, created_at, updated_at
               FROM cdek_sources WHERE channel_id=$1`, [ch.id])).rows[0] || null;
          await w.write(`,"cdek":${JSON.stringify(cdek)}`);

          // То же для Rusender (039). api_key_enc — credential, в SELECT его нет по построению;
          // account_email и scopes витринные и потому переносимы.
          const rusender = (await q(
            `SELECT account_id, account_email, scopes, connected_at, updated_at
               FROM rusender_accounts WHERE channel_id=$1`, [ch.id])).rows[0] || null;
          await w.write(`,"rusender":${JSON.stringify(rusender)}`);

          // API-key metadata переносимо, но key_hash — credential и не выбирается никогда.
          await w.write(',"api_keys":');
          await streamOwnedById(w, q, 'api_keys', 'channel_id',
            'id, key_prefix, label, created_at, last_used_at, revoked_at', ch.id, PAGE);

          const ig = (await q(`SELECT ig_user_id, username, scopes, token_expires_at, connected_at, updated_at
                     FROM ig_accounts WHERE channel_id=$1`, [ch.id])).rows[0] || null;
          // Disconnect удаляет только ig_accounts; historical ig_daily/ig_media_daily остаются
          // привязаны к каналу. Поэтому наличие архива проверяется отдельно от integration identity.
          let hasInstagramArchive = Boolean(ig);
          if (!hasInstagramArchive) {
            hasInstagramArchive = Boolean((await q(
              `SELECT EXISTS (
                 SELECT 1 FROM ig_daily WHERE channel_id=$1
                 UNION ALL
                 SELECT 1 FROM ig_media_daily WHERE channel_id=$1
               ) AS has_instagram_archive`, [ch.id])).rows[0]?.has_instagram_archive);
          }
          if (hasInstagramArchive) {
            await w.write(',"instagram":');
            await w.write(objectPrefix(ig || {
              ig_user_id: null,
              username: null,
              scopes: null,
              token_expires_at: null,
              connected_at: null,
              updated_at: null,
            }));
            await w.write('"daily":'); await streamArchive(w, client, ARCHIVE_SPECS.igDaily, ch.id, PAGE);
            await w.write(',"media_daily":'); await streamArchive(w, client, ARCHIVE_SPECS.igMedia, ch.id, PAGE);
            await w.write('}'); // /instagram
          } else {
            await w.write(',"instagram":null');
          }

          await w.write('}'); // /channel
        }
        if (chRows.length < PAGE) break;
        chCursor = chRows[chRows.length - 1].id;
      }

      await w.write(']}'); // /channels + /root
      await w.end();
      return 'ok';
    } catch (e) {
      if (e instanceof ExportAborted || w.closed) return 'aborted';
      if (started) {
        // Байты уже ушли — второй JSON-ответ невозможен и мог бы «дописать» валидный хвост к
        // усечённому документу. Рвём соединение, чтобы клиент увидел неполную загрузку, и логируем.
        try { res.destroy(e); } catch { /* already gone */ }
        console.error('[gdpr] export stream failed after response started:', e);
        return 'stream_error';
      }
      throw e; // до первого байта — штатный next(err)/500
    } finally {
      w.cleanup();
      client.release();
    }
  }

  return { deleteUserAccount, streamUserExport };
}

module.exports = {
  createGdprService,
  // Экспорт чистых хелперов для юнит-тестов (keyset-предикат, генерация SQL, backpressure-writer).
  _internals: {
    ARCHIVE_SPECS, buildKeysetPredicate, pageQuery, projectRow,
    objectPrefix, createWriter, ExportAborted,
  },
};
