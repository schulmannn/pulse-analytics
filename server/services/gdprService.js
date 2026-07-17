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
// по мере готовности — память ограничена одной страницей, не всем архивом. `workspaces`, `reports`
// и перечень `channels` тоже пагинируются id-keyset'ом: schema разрешает будущие team-workspaces,
// у reports нет пер-юзер капа, а channels-цикл не должен опираться на продуктовый кап ради
// memory-proof. Буферизуются только singleton account/prefs/telegram_session. Размер страницы
// приходит из config через dep (services читают только внедрённые зависимости, не окружение —
// check:boundaries).
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
  igDaily: {
    from: 'ig_daily', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'day', cast: 'date' }], order: 'day ASC',
  },
  igMedia: {
    from: 'ig_media_daily', cols: '*', chanCol: 'channel_id',
    keys: [{ col: 'day', cast: 'date' }, { col: 'media_id', cast: 'text' }],
    order: 'day ASC, media_id ASC',
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
     (+members) / channels(owner_uid), а от channels — все архивы (channel_daily / monthly /
     posts / mentions / channel_mention_settings / velocity / ig_accounts / ig_daily / ig_media_daily / api_keys /
     annotations / snapshots). audit_events.uid и chart_annotations.created_by → SET NULL
     (журнал остаётся, но анонимный). Разделяемые external_sources НЕ трогаются — это identity
     публичного канала, не персональные данные.
     Pre-null: канал ДРУГОГО владельца, живущий в воркспейсе стираемого юзера (инвариант «канал
     в личном воркспейсе создателя» кодом не enforced), переводится в legacy NULL-workspace —
     owner_uid-fallback чтения жив с миграции 010; иначе NO ACTION FK на channels.workspace_id
     валит весь DELETE. */
  async function deleteUserAccount(uid) {
    if (!enabled || uid == null) return false;
    return transaction(async (client) => {
      await client.query(
        `UPDATE channels SET workspace_id = NULL
          WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_uid = $1)
            AND owner_uid IS DISTINCT FROM $1`, [uid]);
      // SET NULL анонимизирует только uid: исторические metadata несут прямые идентификаторы
      // (tg.session.connected — личный @username, ig_oauth_connected, channel.created) — без
      // зачистки «анонимный журнал» ложь (скептик-панель, erasure-completeness).
      await client.query(`UPDATE audit_events SET metadata = '{}'::jsonb WHERE uid = $1`, [uid]);
      const { rowCount } = await client.query('DELETE FROM users WHERE id = $1', [uid]);
      // Осиротевшие external_sources: для приватного канала username/title (часто имя человека)
      // не «shared identity» — если после каскада на источник не ссылается НИКТО, стираем и его.
      // Разделяемые источники (чужие channels/архивы ссылаются) переживают sweep невредимыми.
      await client.query(
        `DELETE FROM external_sources s
          WHERE NOT EXISTS (SELECT 1 FROM channels        t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ig_accounts     t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM channel_daily   t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM channel_monthly t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM posts           t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM velocity_daily  t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM mentions        t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ig_daily        t WHERE t.source_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM ig_media_daily  t WHERE t.source_id = s.id)`);
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

  /* Экспорт персональных данных (GDPR portability) — один JSON-файл, СТРИМОМ (см. шапку модуля).
     Учётные данные не экспортируются НИКОГДА: pass_hash, token_version, tg_sessions.session_enc,
     ig_accounts.access_token_enc и key_hash не попадают в SELECT'ы. Каналы — только owner_uid=uid:
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
        `SELECT tg_user_id, username, connected_at, updated_at FROM tg_sessions WHERE uid=$1`, [uid])).rows[0] || null;

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
      // schema разрешает несколько, поэтому весь набор тоже page'им. `members` остаётся прежним
      // per-workspace json_agg: он ограничен общим числом пользователей, а не числом workspace.
      await w.write('"workspaces":');
      await streamOwnedById(w, q, 'workspaces w', 'w.owner_uid',
        `w.id, w.name, w.created_at,
         (SELECT json_agg(json_build_object('uid', m.uid, 'role', m.role) ORDER BY m.uid)
            FROM workspace_members m WHERE m.workspace_id = w.id) AS members`, uid, PAGE);
      await w.write(',');
      // reports — id-keyset'ом (нет пер-юзер капа); форма/порядок строк прежние.
      await w.write(`"reports":`);
      await streamOwnedById(w, q, 'reports', 'uid',
        'id, name, config, schedule, created_at, updated_at, last_sent_at', uid, PAGE);
      await w.write(',');
      // Присутствие подключения — да; сама сессия — никогда (это credential, не данные).
      await w.write(`"telegram_session":${JSON.stringify(tgSession)},`);
      await w.write(`"channels":[`);

      // Каналы тоже id-keyset'ом: перечень не опирается на продуктовый кап ради memory-proof, а
      // каждый канал сразу стримит свои архивы. Форма/порядок = прежний `ORDER BY id`.
      let chCursor = null;
      let firstChannel = true;
      for (;;) {
        if (w.closed) throw new ExportAborted();
        const chSql = `SELECT id, username, title, source, tg_channel_id, created_at
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
            id: ch.id, username: ch.username, title: ch.title,
            source: ch.source, tg_channel_id: ch.tg_channel_id, created_at: ch.created_at,
          }));

          await w.write('"archive":{');
          await w.write('"daily":'); await streamArchive(w, client, ARCHIVE_SPECS.daily, ch.id, PAGE);
          await w.write(',"monthly":'); await streamArchive(w, client, ARCHIVE_SPECS.monthly, ch.id, PAGE);
          await w.write(',"posts":'); await streamArchive(w, client, ARCHIVE_SPECS.posts, ch.id, PAGE);
          await w.write(',"mentions":'); await streamArchive(w, client, ARCHIVE_SPECS.mentions, ch.id, PAGE);
          await w.write(',"velocity":'); await streamArchive(w, client, ARCHIVE_SPECS.velocity, ch.id, PAGE);
          await w.write(',"annotations":'); await streamArchive(w, client, ARCHIVE_SPECS.annotations, ch.id, PAGE);
          await w.write('}'); // /archive

          const mentionSettings = (await q(
            `SELECT include_terms, exclude_terms, exclude_sources, match_mode, updated_at
               FROM channel_mention_settings WHERE channel_id=$1`, [ch.id])).rows[0] || null;
          await w.write(`,"mention_settings":${JSON.stringify(mentionSettings)}`);

          const ig = (await q(`SELECT ig_user_id, username, scopes, token_expires_at, connected_at, updated_at
                     FROM ig_accounts WHERE channel_id=$1`, [ch.id])).rows[0] || null;
          if (ig) {
            await w.write(',"instagram":');
            await w.write(objectPrefix(ig));
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
