// ═══════════════════════════════════════════════════════════════
//  Atlavue — дневной IG-сбор для крона (job)
// ═══════════════════════════════════════════════════════════════
// IG отдаёт только короткое окно (сторис 24ч, серия follower_count ~30д, у демографии
// истории НЕТ). Крон снимает данные раз в день и складывает в БД, чтобы копить историю
// для будущих графиков. Это НЕ req/res-путь: resolveIg тут неприменим (нет req, нет
// проверки владельца — крон доверенный). Мы напрямую дешифруем токен и зовём igFetch,
// как и живые роуты, но каждый вызов обёрнут в свой try/catch: один битый токен или
// квота-ошибка не должны трогать остальные аккаунты и НИКОГДА не касаются ответа крона
// (весь IG-сбор идёт fire-and-forget ПОСЛЕ res.json, как processReportSchedules).
// Тела перенесены из index.js literal (декомпозиция, PR D); без Express/env/таймеров.

'use strict';

const { toMetricInt } = require('../lib/metricNumber');

function createInstagramCollectionJob({ db, log, igCrypto, igFetch, refreshIgIfNeeded }) {
  // Достаём total_value одной total_value-метрики из ответа /insights.
  // Story-insight metric list + single-metric value parser — used by collectIgSnapshotsForAccount below.
  // routes/ig.js keeps its own copies for the live /api/ig/stories route (cf. tvNames vs IG_TV_NAMES).
  const STORY_METRICS = ['reach', 'views', 'replies', 'shares', 'follows', 'profile_visits', 'total_interactions'];
  const igMetricVal = (j) => {
    const m = j && j.data && j.data[0];
    if (!m) return null;
    if (m.total_value && m.total_value.value != null) return m.total_value.value;
    if (m.values && m.values[0] && m.values[0].value != null) return m.values[0].value;
    return null;
  };
  const igTvVal = (r) => { const m = r && r.data && r.data[0]; return m && m.total_value && m.total_value.value != null ? m.total_value.value : null; };
  // Разбираем follows_and_unfollows (breakdown=follow_type) → { follows, unfollows }.
  const igFauVal = (res) => {
    const block = res && res.data && res.data[0] && res.data[0].total_value && res.data[0].total_value.breakdowns;
    const results = (block && block[0] && block[0].results) || [];
    let follows = null, unfollows = null;
    results.forEach((r) => {
      const k = r.dimension_values && r.dimension_values[0];
      if (k === 'FOLLOWER') follows = r.value;
      else if (k === 'NON_FOLLOWER') unfollows = r.value;
    });
    return { follows, unfollows };
  };
  // Дневной fau ВЫЧИТАНИЕМ двух многодневных окон: вчера = fau[якорь, сегодня) − fau[якорь, вчера).
  // Однодневное окно follows_and_unfollows на проде возвращает ПУСТОЙ breakdown (при том, что все
  // остальные total_value-метрики тем же окном приходят) — из-за этого архив follows/unfollows был
  // NULL с первого дня крона: гейт нарратива f7 молча не проходил, а реконструкции уровня
  // «Подписчиков» не от чего строиться. Многодневные окна демонстрируемо работают (живой KPI);
  // fau аддитивен по дням — разность точна. Отрицательная разность (шум финализации Meta)
  // клампится в 0, вызывающий логирует warn.
  const igFauDiff = (wide, narrow) => {
    const clamp = (a, b) => (a == null || b == null ? null : Math.max(0, a - b));
    return { follows: clamp(wide.follows, narrow.follows), unfollows: clamp(wide.unfollows, narrow.unfollows) };
  };
  const IG_TV_NAMES = ['views', 'profile_views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares'];
  // Нормализация счётчика — та же, что num() в collectorRepo: колонки ig_daily/ig_media_daily теперь
  // BIGINT (миграция 023), поэтому принимаем точные целые до MAX_SAFE_METRIC, а всё за границей честно
  // даёт null вместо выдуманного насыщенного значения. null и ноль сохраняются как есть.
  const igNum = toMetricInt;

  // Собираем дневные метрики аккаунта ровно за ОДИН календарный день — ВЧЕРА (UTC).
  // Окно строго [вчера 00:00, сегодня 00:00): сегодня частичный/нефинализированный, а окно
  // ШИРЕ одного дня заставило бы соседние прогоны крона перекрываться и удваивать суммы
  // total_value при агрегации по периоду (windowPair на фронте суммирует дневные строки).
  // reach/follower_count — дневная серия (единственная точка за вчера), остальное — window-
  // агрегаты total_value за это же однодневное окно. row.day = вчера (день, к которому относятся данные).
  async function collectIgDailyForAccount(acc, token) {
    const SEC = 86400;
    const now = Math.floor(Date.now() / 1000);
    const todayMidnight = Math.floor(now / SEC) * SEC;   // UTC-полночь сегодня
    const since = todayMidnight - SEC, until = todayMidnight;   // ровно вчера, одни сутки
    const targetDay = new Date(since * 1000).toISOString().slice(0, 10);   // YYYY-MM-DD вчера
    const id = acc.ig_user_id;
    const row = { day: targetDay };
    // Дневные серии reach + follower_count — одним вызовом (одна точка за вчерашние сутки).
    try {
      const daily = await igFetch(`/${id}/insights`, { metric: 'reach,follower_count', period: 'day', since, until }, token);
      (daily.data || []).forEach((m) => {
        const vals = m.values || [];
        const last = vals.length ? vals[vals.length - 1].value : null;   // финализированная точка за вчера
        if (m.name === 'reach') row.reach = igNum(last);
        else if (m.name === 'follower_count') row.followers = igNum(last);
      });
    } catch (e) { log('warn', 'ig_cron_daily_series_failed', { channelId: acc.channel_id, error: e.message }); }
    // Window-агрегаты total_value (каждая метрика независимо — одна неподдерживаемая не рушит остальные).
    const settled = await Promise.allSettled(
      IG_TV_NAMES.map((metric) => igFetch(`/${id}/insights`, { metric, metric_type: 'total_value', period: 'day', since, until }, token)));
    settled.forEach((r, i) => { if (r.status === 'fulfilled') row[IG_TV_NAMES[i]] = igNum(igTvVal(r.value)); });
    // follows_and_unfollows → follows / unfollows за вчера. НЕ однодневным окном (оно возвращает
    // пустой breakdown — см. igFauDiff выше), а разностью двух окон с общим якорем −8 дней:
    // wide = [якорь, сегодня) покрывает вчера, narrow = [якорь, вчера) — нет; wide − narrow = вчера.
    try {
      const anchor = until - 8 * SEC;
      const fauArgs = { metric: 'follows_and_unfollows', metric_type: 'total_value', breakdown: 'follow_type', period: 'day' };
      const [wideRes, narrowRes] = await Promise.all([
        igFetch(`/${id}/insights`, { ...fauArgs, since: anchor, until }, token),
        igFetch(`/${id}/insights`, { ...fauArgs, since: anchor, until: since }, token),
      ]);
      const wide = igFauVal(wideRes), narrow = igFauVal(narrowRes);
      if ((wide.follows != null && narrow.follows != null && wide.follows < narrow.follows) ||
          (wide.unfollows != null && narrow.unfollows != null && wide.unfollows < narrow.unfollows)) {
        log('warn', 'ig_cron_fau_negative_diff', { channelId: acc.channel_id, wide, narrow });
      }
      const day = igFauDiff(wide, narrow);
      row.follows = igNum(day.follows); row.unfollows = igNum(day.unfollows);
    } catch (e) { log('warn', 'ig_cron_fau_failed', { channelId: acc.channel_id, error: e.message }); }
    // Абсолютный уровень базы (профильный followers_count) — исторических уровней IG не отдаёт,
    // поэтому фиксируем «сейчас» при каждом дневном сборе. Ставится на вчерашнюю строку: сбор
    // идёт ранним утром, значение ≈ уровень конца вчерашнего дня (честная погрешность в часы,
    // фронт использует эти точки как якоря графика уровня «Подписчики»).
    try {
      const prof = await igFetch(`/${id}`, { fields: 'followers_count' }, token);
      row.followers_total = igNum(prof && prof.followers_count);
    } catch (e) { log('warn', 'ig_cron_followers_total_failed', { channelId: acc.channel_id, error: e.message }); }
    await db.upsertIgDaily(acc.channel_id, [row]);
    return row;
  }

  // Per-media lifetime-инсайты. Квота-бюджет: тянем insights только для НОВЫХ или
  // «молодых» медиа (<7 дней) — у старых lifetime-числа почти не двигаются, а фан-аут
  // «25 медиа × N вызовов» каждый день сжигает квоту зря. Одна строка на (media, day) →
  // накопительная траектория.
  const IG_MEDIA_INSIGHT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  async function collectIgMediaForAccount(acc, token, day) {
    const id = acc.ig_user_id;
    const mediaRes = await igFetch(`/${id}/media`, {
      fields: 'id,media_type,media_product_type,timestamp,like_count,comments_count', limit: 25,
    }, token);
    const list = (mediaRes.data || []).filter((post) => {
      const t = post.timestamp ? new Date(post.timestamp).getTime() : NaN;
      return !Number.isFinite(t) || (Date.now() - t) <= IG_MEDIA_INSIGHT_MAX_AGE_MS;   // новые/молодые
    });
    const rows = [];
    for (const post of list) {   // последовательно — по-доброму к квоте одного токена
      try {
        const ins = await igFetch(`/${post.id}/insights`, { metric: 'reach,views,shares,saved,total_interactions', metric_type: 'total_value' }, token);
        const m = {};
        (ins.data || []).forEach((x) => { m[x.name] = igNum(x.total_value && x.total_value.value != null ? x.total_value.value : (x.values && x.values[0] ? x.values[0].value : null)); });
        rows.push({
          media_id: String(post.id), day,
          reach: m.reach ?? null, views: m.views ?? null, shares: m.shares ?? null,
          saved: m.saved ?? null, total_interactions: m.total_interactions ?? null,
          likes: igNum(post.like_count), comments: igNum(post.comments_count),
        });
      } catch (e) { log('warn', 'ig_cron_media_insight_failed', { channelId: acc.channel_id, media: post.id, error: e.message }); }
    }
    if (rows.length) await db.upsertIgMediaDaily(acc.channel_id, rows);
    return rows.length;
  }

  // Демография / online / stories — истории у Meta НЕТ (демография = текущий срез,
  // сторис живут 24ч), поэтому снимаем сырой payload «как есть» в raw_snapshots, чтобы
  // СТРОИТЬ свою историю. Каждая секция изолирована: сбой одной не трогает остальные.
  async function collectIgSnapshotsForAccount(acc, token, day) {
    const id = acc.ig_user_id;
    // Demographics — те же 6 breakdown-вызовов, что и роут /breakdowns.
    try {
      const calls = [
        { metric: 'follower_demographics', breakdown: 'age', period: 'lifetime', metric_type: 'total_value', timeframe: 'last_30_days' },
        { metric: 'follower_demographics', breakdown: 'gender', period: 'lifetime', metric_type: 'total_value', timeframe: 'last_30_days' },
        { metric: 'follower_demographics', breakdown: 'country', period: 'lifetime', metric_type: 'total_value', timeframe: 'last_30_days' },
        { metric: 'follower_demographics', breakdown: 'city', period: 'lifetime', metric_type: 'total_value', timeframe: 'last_30_days' },
        { metric: 'total_interactions', breakdown: 'media_product_type', period: 'day', metric_type: 'total_value' },
        { metric: 'profile_links_taps', breakdown: 'contact_button_type', period: 'day', metric_type: 'total_value' },
      ];
      const settled = await Promise.allSettled(calls.map((c) => igFetch(`/${id}/insights`, c, token)));
      const data = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value?.data || []);
      if (data.length) await db.saveRawSnapshot(acc.channel_id, 'ig', 'demographics', day, { data });
    } catch (e) { log('warn', 'ig_cron_demographics_failed', { channelId: acc.channel_id, error: e.message }); }
    // Online followers — почасовая карта (часто пустая → пишем только непустое).
    try {
      const online = await igFetch(`/${id}/insights`, { metric: 'online_followers', period: 'lifetime' }, token);
      const data = online?.data || [];
      if (data.length) await db.saveRawSnapshot(acc.channel_id, 'ig', 'online', day, { data });
    } catch (e) { log('warn', 'ig_cron_online_failed', { channelId: acc.channel_id, error: e.message }); }
    // Stories — живут ~24ч, снимаем список + per-story insights (allSettled), иначе теряются навсегда.
    // Кэп фан-аута: каждая сторис = 7 вызовов insights; ограничиваем число обрабатываемых сторис,
    // чтобы всплеск активных сторис не сжёг квоту токена за один прогон (типично их единицы).
    const IG_STORY_MAX = 30;
    try {
      const listRes = await igFetch(`/${id}/stories`, { fields: 'id,media_type,timestamp,permalink,thumbnail_url' }, token);
      const storyList = (listRes.data || []).slice(0, IG_STORY_MAX);
      if ((listRes.data || []).length > IG_STORY_MAX) {
        log('warn', 'ig_cron_stories_truncated', { channelId: acc.channel_id, total: listRes.data.length, cap: IG_STORY_MAX });
      }
      const stories = await Promise.all(storyList.map(async (s) => {
        const out = { ...s };
        const st = await Promise.allSettled(STORY_METRICS.map((metric) => igFetch(`/${s.id}/insights`, { metric, metric_type: 'total_value' }, token)));
        st.forEach((r, i) => { if (r.status === 'fulfilled') { const v = igMetricVal(r.value); if (v != null) out[STORY_METRICS[i]] = v; } });
        return out;
      }));
      if (stories.length) await db.saveRawSnapshot(acc.channel_id, 'ig', 'stories', day, { data: stories });
    } catch (e) { log('warn', 'ig_cron_stories_failed', { channelId: acc.channel_id, error: e.message }); }
  }

  // Полный дневной сбор для одного IG-аккаунта: дешифровка токена (+ opportunistic refresh,
  // чтобы крон заодно держал 60-дневный токен живым), затем daily / media / snapshots. Любой
  // сбой одной секции логируется и НЕ прерывает остальные и не всплывает выше.
  async function collectIgForAccount(acc, day) {
    let token;
    try {
      token = igCrypto.decrypt(acc.access_token_enc);   // бросает при отсутствии/ротации IG_TOKEN_KEY или битом блобе
    } catch (e) {
      log('warn', 'ig_token_decrypt_failed', { channelId: acc.channel_id, error: e.message });
      return;   // один недешифруемый аккаунт не рушит весь прогон
    }
    token = await refreshIgIfNeeded(acc.channel_id, token, acc.token_expires_at);   // крон = heartbeat рефреша токена
    try { await collectIgDailyForAccount(acc, token); }        catch (e) { log('error', 'ig_cron_daily_failed', { channelId: acc.channel_id, error: e.message }); }
    try { await collectIgMediaForAccount(acc, token, day); }   catch (e) { log('error', 'ig_cron_media_failed', { channelId: acc.channel_id, error: e.message }); }
    try { await collectIgSnapshotsForAccount(acc, token, day); } catch (e) { log('error', 'ig_cron_snapshots_failed', { channelId: acc.channel_id, error: e.message }); }
  }

  return { collectIgForAccount };
}

module.exports = { createInstagramCollectionJob };
