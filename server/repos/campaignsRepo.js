'use strict';

/* ── Campaigns repo («Кампании и группы контента») ────────────────────────────────────────────────
   Кампания = именованная группа публикаций из доступных источников (016_campaigns.sql).
   Скоуп — WORKSPACE (ADR-001): читает любой участник воркспейса (включая viewer), пишет
   member/admin/owner. Роут различает 404 (кампания вне доступа/нет) и 403 (viewer пишет)
   через my_role, который отдают list/get; write-методы дополнительно ВШИВАЮТ writable-предикат
   в WHERE (defense in depth против TOCTOU).

   Membership (campaign_posts) хранит платформу + внутренний channel_id + устойчивый post id
   (tg → posts.post_id, ig → media_id) и неизменяемые описательные поля. Метрики НЕ копируются:
   listCampaignPosts/summary читают их join'ом из posts (канонический source-union, как в
   analyticsRepo.listPostsInternal) и ig_media_daily (свежая строка на media). Чтения — row-wise
   «ForActor»: метрики/название канала отдаются ТОЛЬКО по каналам, доступным ЧИТАТЕЛЮ
   (channelAccessSql); чужой канал в team-кампании превращается в заглушку accessible=false,
   а не в утечку.

   Семантические ошибки для роута: throw Error с .code —
     'campaign_name_conflict' (unique-нарушение имени)     → 409
     'campaign_limit'         (лимит membership)           → 409
   Всё остальное по конвенции репо: null/false = не найдено/нет доступа (роут → 404),
   пустые guard'ы при !enabled. Зависимости: pool + enabled + transaction
   (инъекция channelsRepo — repos не импортят друг друга). */

const { channelAccessSql, sameTenantSource } = require('../db/access');

const CAMPAIGN_STATUSES = ['active', 'completed', 'archived'];
const CAMPAIGN_NETWORKS = ['tg', 'ig'];
// Потолки: защита от бесконечного роста membership и от гигантских батчей в одном запросе.
const CAMPAIGN_POSTS_LIMIT = 500;
const CAMPAIGN_BATCH_LIMIT = 100;

function createCampaignsRepo({ pool, enabled, transaction }) {
  const ISO = `'YYYY-MM-DD"T"HH24:MI:SSOF'`;
  const CAMPAIGN_COLS = `c.id, c.workspace_id, c.name, c.description, c.color, c.status,
    to_char(c.start_date,'YYYY-MM-DD') AS start_date,
    to_char(c.end_date,'YYYY-MM-DD') AS end_date,
    c.created_by,
    to_char(c.created_at,${ISO}) AS created_at,
    to_char(c.updated_at,${ISO}) AS updated_at`;
  // Доступ читателя: создатель воркспейса ИЛИ его участник; роль — как в channelsRepo.getChannel.
  const MY_ROLE = `CASE WHEN w.owner_uid = $1 THEN 'owner' ELSE m.role END`;
  const ACCESS_JOIN = `JOIN workspaces w ON w.id = c.workspace_id
    LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.uid = $1`;
  const READ_WHERE = `(w.owner_uid = $1 OR m.uid IS NOT NULL)`;
  const WRITE_WHERE = `(w.owner_uid = $1 OR m.role IN ('member','admin','owner'))`;
  const POST_COUNT = `(SELECT count(*)::int FROM campaign_posts cp WHERE cp.campaign_id = c.id)`;

  function assertWritableCampaign(campaign) {
    if (['member', 'admin', 'owner'].includes(campaign.my_role)) return;
    const err = new Error('Недостаточно прав в рабочем пространстве');
    err.code = 'campaign_role_forbidden';
    throw err;
  }

  const nameConflict = (e) => {
    if (e && e.code === '23505' && /campaigns_ws_name_uniq/.test(e.constraint || e.message || '')) {
      const err = new Error('Кампания с таким названием уже есть');
      err.code = 'campaign_name_conflict';
      return err;
    }
    return e;
  };

  async function listCampaigns(uid, { status, channelId } = {}) {
    if (!enabled || uid == null) return [];
    const vals = [uid];
    let where = READ_WHERE;
    if (status != null) {
      if (!CAMPAIGN_STATUSES.includes(status)) throw new Error('bad status');
      vals.push(status);
      where += ` AND c.status = $${vals.length}`;
    }
    if (channelId != null) {
      vals.push(channelId);
      const channelParam = `$${vals.length}`;
      where += ` AND c.workspace_id = (
        SELECT scope.workspace_id
          FROM channels scope
         WHERE scope.id = ${channelParam} AND scope.status <> 'disabled'
           AND ${channelAccessSql({ channelAlias: 'scope', uidParam: '$1' })}
      )`;
    }
    const { rows } = await pool.query(
      `SELECT ${CAMPAIGN_COLS}, ${MY_ROLE} AS my_role, ${POST_COUNT} AS post_count
         FROM campaigns c ${ACCESS_JOIN}
        WHERE ${where}
        ORDER BY c.updated_at DESC, c.id DESC`, vals);
    return rows;
  }

  // Ownership-checked fetch: null и для «нет», и для «не мой воркспейс» (роут → 404, без утечки).
  async function getCampaign(uid, id, executor = pool, { forUpdate = false } = {}) {
    if (!enabled || uid == null || !id) return null;
    const { rows } = await executor.query(
      `SELECT ${CAMPAIGN_COLS}, ${MY_ROLE} AS my_role, ${POST_COUNT} AS post_count
         FROM campaigns c ${ACCESS_JOIN}
        WHERE c.id = $2 AND ${READ_WHERE}${forUpdate ? ' FOR UPDATE OF c' : ''}`, [uid, id]);
    return rows[0] || null;
  }

  // Resolve the workspace through an accessible source, rather than trusting a raw workspace id
  // from the client. Viewer remains read-only; member/admin/owner can create.
  async function writableChannelScope(uid, channelId, executor = pool) {
    const { rows } = await executor.query(
      `SELECT ch.id, ch.workspace_id,
              CASE WHEN w.owner_uid = $1 THEN 'owner' ELSE m.role END AS my_role
         FROM channels ch
         JOIN workspaces w ON w.id = ch.workspace_id
         LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.uid = $1
        WHERE ch.id = $2 AND ch.status <> 'disabled'
          AND ${channelAccessSql({ channelAlias: 'ch', uidParam: '$1' })}`,
      [uid, channelId]);
    const row = rows[0] || null;
    if (!row) {
      const err = new Error('No access to the source');
      err.code = 'campaign_channel_forbidden';
      throw err;
    }
    if (!['member', 'admin', 'owner'].includes(row.my_role)) {
      const err = new Error('Insufficient workspace role');
      err.code = 'campaign_role_forbidden';
      throw err;
    }
    return row;
  }

  // The selected source anchors the campaign to its workspace. The client never chooses a raw
  // workspace id, and membership cannot later cross that boundary.
  async function createCampaign(uid, { channel_id, name, description, color, status, start_date, end_date } = {}) {
    if (!enabled || uid == null) return null;
    const scope = await writableChannelScope(uid, channel_id);
    if (status != null && !CAMPAIGN_STATUSES.includes(status)) throw new Error('bad status');
    try {
      const { rows } = await pool.query(
        `INSERT INTO campaigns (workspace_id, name, description, color, status, start_date, end_date, created_by)
         VALUES ($2, $3, $4, $5, COALESCE($6,'active'), $7, $8, $1)
         RETURNING ${CAMPAIGN_COLS.replaceAll('c.', 'campaigns.')}, 0 AS post_count`,
        [uid, scope.workspace_id, String(name).slice(0, 120), String(description || '').slice(0, 2000),
          color || null, status || null, start_date || null, end_date || null]);
      return rows[0] ? { ...rows[0], my_role: scope.my_role } : null;
    } catch (e) {
      throw nameConflict(e);
    }
  }

  // Partial update; недостающие поля не трогаем, явный null очищает (color/даты/description).
  // WHERE вшивает writable-предикат: viewer/чужой → 0 строк → null (роут уже различил 403/404
  // через getCampaign, здесь — только страховка от гонки).
  async function updateCampaign(uid, id, patch = {}) {
    if (!enabled || uid == null || !id) return null;
    const sets = [];
    const vals = [uid, id];
    let i = 3;
    const set = (col, v) => { sets.push(`${col}=$${i++}`); vals.push(v); };
    if (patch.name !== undefined) set('name', String(patch.name).slice(0, 120));
    if (patch.description !== undefined) set('description', String(patch.description || '').slice(0, 2000));
    if (patch.color !== undefined) set('color', patch.color || null);
    if (patch.status !== undefined) {
      if (!CAMPAIGN_STATUSES.includes(patch.status)) throw new Error('bad status');
      set('status', patch.status);
    }
    if (patch.start_date !== undefined) set('start_date', patch.start_date || null);
    if (patch.end_date !== undefined) set('end_date', patch.end_date || null);
    if (!sets.length) return getCampaign(uid, id);
    try {
      const { rows } = await pool.query(
        `UPDATE campaigns c SET ${sets.join(', ')}, updated_at = now()
          FROM workspaces w
          LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.uid = $1
         WHERE c.id = $2 AND w.id = c.workspace_id AND ${WRITE_WHERE}
         RETURNING ${CAMPAIGN_COLS}, ${MY_ROLE} AS my_role, ${POST_COUNT} AS post_count`, vals);
      return rows[0] || null;
    } catch (e) {
      throw nameConflict(e);
    }
  }

  // Удаляет кампанию + membership (FK CASCADE); сами публикации (posts/ig_media_daily) не трогаются.
  async function deleteCampaign(uid, id) {
    if (!enabled || uid == null || !id) return false;
    const { rowCount } = await pool.query(
      `DELETE FROM campaigns c
        USING workspaces w LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.uid = $1
        WHERE c.id = $2 AND w.id = c.workspace_id AND ${WRITE_WHERE}`, [uid, id]);
    return rowCount > 0;
  }

  // Accessible channels with the workspace and the platform(s) they host, needed to validate
  // membership. A channel is NOT single-network: a Telegram channel can carry a linked Instagram
  // account (hybrid = two sources; its `source_id` stays the TG source while the IG side lives on
  // `ig_accounts.source_id` — see migration 010). Deriving one canonical network would reject
  // adding IG posts from such a channel, so we expose has_tg/has_ig and accept either.
  async function accessibleChannelRows(uid, channelIds, executor = pool) {
    if (!channelIds.length) return new Map();
    const { rows } = await executor.query(
      `SELECT channels.id, channels.workspace_id,
              (channels.source IS DISTINCT FROM 'ig'
                 OR channels.tg_channel_id IS NOT NULL
                 OR es.network = 'tg') AS has_tg,
              (channels.source = 'ig'
                 OR es.network = 'ig'
                 OR EXISTS (SELECT 1 FROM ig_accounts ia WHERE ia.channel_id = channels.id)) AS has_ig
         FROM channels
         LEFT JOIN external_sources es ON es.id = channels.source_id
        WHERE channels.id = ANY($2::int[]) AND channels.status <> 'disabled'
          AND ${channelAccessSql({ uidParam: '$1' })}`, [uid, channelIds]);
    return new Map(rows.map((r) => [r.id, r]));
  }

  // TG-метаданные по архиву: канонический source-union (как listPostsInternal), свежайшая строка.
  async function tgPostMeta(channelId, postIds, executor = pool) {
    if (!postIds.length) return new Map();
    const { rows } = await executor.query(
      `SELECT DISTINCT ON (p.post_id) p.post_id, p.date_published, p.media_type, p.caption
         FROM posts p JOIN channels c ON c.id = $1
        WHERE ((c.source_id IS NOT NULL AND p.source_id = c.source_id AND ${sameTenantSource('p', 'c')})
               OR p.channel_id = c.id)
          AND p.post_id = ANY($2::bigint[])
        ORDER BY p.post_id, p.updated_at DESC NULLS LAST`, [channelId, postIds]);
    return new Map(rows.map((r) => [String(r.post_id), r]));
  }

  /* Batch-добавление публикаций. items: [{network, channel_id, post_ref,
     published_at?, media_type?, caption?}] (метаданные значимы только для ig —
     tg обогащается из архива и клиентские значения игнорирует).
     Возвращает { added, skipped, invalid: [{network,channel_id,post_ref,reason}] } |
     null (кампания вне доступа) | throw с доменным code.
     Недоступный КАНАЛ — не «invalid», а причина отказа всего запроса: роут отдаёт 403
     (нельзя тыкать чужие channel_id и по ответу перебирать, какие существуют).
     Идемпотентность: повторное добавление того же поста — ON CONFLICT DO NOTHING → skipped. */
  async function addCampaignPosts(uid, campaignId, items) {
    if (!enabled || uid == null || !campaignId) return null;
    return transaction(async (executor) => {
      // Lock one campaign row so concurrent batches serialize their exact limit check.
      const campaign = await getCampaign(uid, campaignId, executor, { forUpdate: true });
      if (!campaign) return null;
      assertWritableCampaign(campaign);

      const channelIds = [...new Set(items.map((it) => it.channel_id))];
      const channels = await accessibleChannelRows(uid, channelIds, executor);
      const forbidden = channelIds.filter((id) => !channels.has(id));
      if (forbidden.length) {
        const err = new Error('Нет доступа к источнику');
        err.code = 'campaign_channel_forbidden';
        err.channels = forbidden;
        throw err;
      }
      const wrongWorkspace = channelIds.filter((id) => channels.get(id).workspace_id !== campaign.workspace_id);
      if (wrongWorkspace.length) {
        const err = new Error('Источник относится к другому рабочему пространству');
        err.code = 'campaign_workspace_mismatch';
        throw err;
      }
      const wrongNetwork = items.filter((it) => {
        const ch = channels.get(it.channel_id);
        return it.network === 'ig' ? !ch.has_ig : !ch.has_tg;
      });
      if (wrongNetwork.length) {
        const err = new Error('Платформа публикации не совпадает с источником');
        err.code = 'campaign_network_mismatch';
        throw err;
      }

      const { rows: existingRows } = await executor.query(
        `SELECT network, channel_id, post_ref FROM campaign_posts WHERE campaign_id = $1`, [campaignId]);
      const existing = new Set(existingRows.map((r) => `${r.network}:${r.channel_id}:${r.post_ref}`));
      // TG metadata is authoritative from the archive. IG descriptive metadata comes from the live
      // Graph listing; metrics still join from ig_media_daily and are never accepted from the client.
      const tgMetaByChannel = new Map();
      for (const chId of channelIds) {
        const refs = items
          .filter((it) => it.network === 'tg' && it.channel_id === chId)
          .map((it) => it.post_ref);
        if (refs.length) tgMetaByChannel.set(chId, await tgPostMeta(chId, refs, executor));
      }

      const invalid = [];
      const values = [];
      const validKeys = [];
      const vals = [campaignId, campaign.workspace_id, uid];
      let i = 4;
      for (const it of items) {
        let publishedAt = null;
        let mediaType = null;
        let caption = null;
        if (it.network === 'tg') {
          const meta = (tgMetaByChannel.get(it.channel_id) || new Map()).get(it.post_ref);
          if (!meta) {
            invalid.push({ network: it.network, channel_id: it.channel_id, post_ref: it.post_ref, reason: 'post_not_found' });
            continue;
          }
          publishedAt = meta.date_published;
          mediaType = meta.media_type || null;
          caption = meta.caption ? String(meta.caption).slice(0, 300) : null;
        } else {
          publishedAt = it.published_at || null;
          mediaType = it.media_type ? String(it.media_type).slice(0, 40) : null;
          caption = it.caption ? String(it.caption).slice(0, 300) : null;
        }
        validKeys.push(`${it.network}:${it.channel_id}:${it.post_ref}`);
        values.push(`($1, $2, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $3)`);
        vals.push(it.network, it.channel_id, it.post_ref, publishedAt, mediaType, caption);
      }

      const newCount = validKeys.filter((key) => !existing.has(key)).length;
      if (existingRows.length + newCount > CAMPAIGN_POSTS_LIMIT) {
        const err = new Error(`Лимит публикаций в кампании — ${CAMPAIGN_POSTS_LIMIT}`);
        err.code = 'campaign_limit';
        throw err;
      }

      let added = 0;
      if (values.length) {
        const { rowCount } = await executor.query(
          `INSERT INTO campaign_posts (campaign_id, workspace_id, network, channel_id, post_ref, published_at, media_type, caption, added_by)
           VALUES ${values.join(', ')}
           ON CONFLICT (campaign_id, network, channel_id, post_ref) DO NOTHING`, vals);
        added = rowCount;
        if (added > 0) await executor.query(`UPDATE campaigns SET updated_at = now() WHERE id = $1`, [campaignId]);
      }
      return { added, skipped: items.length - invalid.length - added, invalid };
    });
  }

  // Batch-удаление membership; сами публикации никогда не трогаются.
  async function removeCampaignPosts(uid, campaignId, items) {
    if (!enabled || uid == null || !campaignId) return null;
    return transaction(async (executor) => {
      const campaign = await getCampaign(uid, campaignId, executor, { forUpdate: true });
      if (!campaign) return null;
      assertWritableCampaign(campaign);
      if (!items.length) return { removed: 0 };
      const conds = [];
      const vals = [campaignId];
      let i = 2;
      for (const it of items) {
        conds.push(`(network = $${i++} AND channel_id = $${i++} AND post_ref = $${i++})`);
        vals.push(it.network, it.channel_id, it.post_ref);
      }
      const { rowCount } = await executor.query(
        `DELETE FROM campaign_posts WHERE campaign_id = $1 AND (${conds.join(' OR ')})`, vals);
      if (rowCount > 0) await executor.query(`UPDATE campaigns SET updated_at = now() WHERE id = $1`, [campaignId]);
      return { removed: rowCount };
    });
  }

  /* Публикации кампании, обогащённые метриками НА ЛЕТУ (копий аналитики в membership нет):
       tg → свежайшая строка posts по каноническому source-union члена-канала;
       ig → свежайшая (по day) строка ig_media_daily этого канала+media.
     Row-wise ForActor: канал, недоступный ЧИТАТЕЛЮ, отдаётся заглушкой accessible=false без
     метрик/названия (роут дополнительно прячет caption). post_ref для tg пишется только из
     архива (цифры), но guard `~ '^\d+$'` страхует cast от мусора. */
  async function listCampaignPosts(uid, campaignId) {
    if (!enabled || uid == null || !campaignId) return null;
    const campaign = await getCampaign(uid, campaignId);
    if (!campaign) return null;
    const { rows } = await pool.query(
      `SELECT cp.network, cp.channel_id, cp.post_ref,
              to_char(cp.published_at,${ISO}) AS published_at,
              cp.media_type, cp.caption,
              to_char(cp.added_at,${ISO}) AS added_at,
              ch.title AS channel_title, ch.username AS channel_username,
              (ch.id IS NOT NULL) AS accessible,
              tg.views AS tg_views, tg.reactions AS tg_reactions,
              tg.forwards AS tg_forwards, tg.replies AS tg_replies,
              ig.reach AS ig_reach, ig.views AS ig_views, ig.likes AS ig_likes,
              ig.comments AS ig_comments, ig.saved AS ig_saved, ig.shares AS ig_shares
         FROM campaign_posts cp
         LEFT JOIN channels ch ON ch.id = cp.channel_id AND ch.status <> 'disabled'
              AND ${channelAccessSql({ channelAlias: 'ch', uidParam: '$2' })}
         LEFT JOIN LATERAL (
           SELECT p.views, p.reactions, p.forwards, p.replies
             FROM posts p
            WHERE cp.network = 'tg' AND ch.id IS NOT NULL AND cp.post_ref ~ '^\\d+$'
              AND ((ch.source_id IS NOT NULL AND p.source_id = ch.source_id AND ${sameTenantSource('p', 'ch')})
                   OR p.channel_id = ch.id)
              AND p.post_id = cp.post_ref::bigint
            ORDER BY p.updated_at DESC NULLS LAST LIMIT 1
         ) tg ON true
         LEFT JOIN LATERAL (
           SELECT d.reach, d.likes, d.comments, d.saved, d.shares, d.views
             FROM ig_media_daily d
            WHERE cp.network = 'ig' AND ch.id IS NOT NULL
              AND d.channel_id = cp.channel_id AND d.media_id = cp.post_ref
            ORDER BY d.day DESC LIMIT 1
         ) ig ON true
        WHERE cp.campaign_id = $1
        ORDER BY cp.published_at DESC NULLS LAST, cp.network ASC, cp.post_ref DESC`,
      [campaignId, uid]);
    return rows;
  }

  const median = (nums) => {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const sum = (nums) => nums.reduce((a, b) => a + b, 0);
  const round1 = (x) => Math.round(x * 10) / 10;
  const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : null);
  const postKey = (r) => ({ network: r.network, channel_id: r.channel_id, post_ref: r.post_ref, caption: r.caption, published_at: r.published_at });

  /* Сводка кампании. Метрики платформ НЕ смешиваются в одну цифру (методологии разные:
     tg.views — показы поста, ig.reach — охват отдельного поста, ig.views — просмотры/plays).
     Сумма ig.reach не дедуплицирует одну аудиторию между несколькими публикациями;
     фронт подписывает различия. Best/worst — относительно МЕДИАНЫ своей платформы
     (ratio = metric/median), поэтому сравнимы между платформами только как коэффициенты.
     Сравнение с предыдущим равным периодом: только TG (дата публикации любого архивного
     поста известна БД) и только при prev_posts >= 3; для IG дат вне membership в БД нет →
     всегда insufficient. Недоступные читателю источники в метрики не входят и отражаются
     в inaccessible_posts.

     Опциональный точный срез по ИСТОЧНИКУ (identity = (network, channel_id)): оба параметра
     задаются вместе (роут это гарантирует). Срез отбирает строки, которые ОДНОВРЕМЕННО доступны
     читателю И точно совпадают по network+channel_id, ДО любых агрегаций — поэтому угаданный/
     недоступный источник даёт честную ПУСТУЮ сводку (0 публикаций, пустые разбивки), не раскрывая
     ни метрик, ни существования других источников. Без параметров поведение прежнее. */
  async function getCampaignSummary(uid, campaignId, { network, channelId } = {}) {
    if (!enabled || uid == null || !campaignId) return null;
    const campaign = await getCampaign(uid, campaignId);
    if (!campaign) return null;
    const allRows = await listCampaignPosts(uid, campaignId);
    if (allRows == null) return null;

    const scoped = network != null && channelId != null;
    const rows = scoped
      ? allRows.filter((r) => r.accessible && r.network === network && r.channel_id === channelId)
      : allRows;

    const acc = rows.filter((r) => r.accessible);
    const tgRows = acc.filter((r) => r.network === 'tg');
    const igRows = acc.filter((r) => r.network === 'ig');

    const platform = (list, metricCol, totals) => {
      const metric = list.map((r) => r[metricCol]).filter((v) => v != null).map(Number);
      const med = median(metric);
      let best = null;
      let worst = null;
      if (med != null && med > 0) {
        const scored = list
          .filter((r) => r[metricCol] != null)
          .map((r) => ({ ...postKey(r), value: Number(r[metricCol]), ratio: round1(Number(r[metricCol]) / med) }));
        scored.sort((a, b) => b.value - a.value);
        best = scored[0] || null;
        worst = scored.length > 1 ? scored[scored.length - 1] : null;
      }
      const out = { posts: list.length, best, worst, median: med, avg: metric.length ? round1(sum(metric) / metric.length) : null };
      for (const [k, col] of Object.entries(totals)) {
        const vals = list.map((r) => r[col]).filter((v) => v != null).map(Number);
        out[k] = vals.length ? sum(vals) : null;
      }
      return out;
    };

    const tg = platform(tgRows, 'tg_views', {
      views: 'tg_views', reactions: 'tg_reactions', forwards: 'tg_forwards', replies: 'tg_replies',
    });
    const ig = platform(igRows, 'ig_reach', {
      reach: 'ig_reach', views: 'ig_views', likes: 'ig_likes', comments: 'ig_comments',
      saved: 'ig_saved', shares: 'ig_shares',
    });

    // Разбивки: источники и форматы (метрика — своя на платформу, без смешивания).
    const bySource = new Map();
    const byFormat = new Map();
    for (const r of acc) {
      const sk = `${r.network}:${r.channel_id}`;
      const s = bySource.get(sk) || {
        network: r.network, channel_id: r.channel_id,
        title: r.channel_title, username: r.channel_username,
        posts: 0, tg_views: null, ig_reach: null,
      };
      s.posts += 1;
      if (r.network === 'tg' && r.tg_views != null) s.tg_views = (s.tg_views || 0) + Number(r.tg_views);
      if (r.network === 'ig' && r.ig_reach != null) s.ig_reach = (s.ig_reach || 0) + Number(r.ig_reach);
      bySource.set(sk, s);

      const fk = `${r.network}:${r.media_type || 'unknown'}`;
      const f = byFormat.get(fk) || {
        network: r.network, media_type: r.media_type || null,
        posts: 0, tg_views: null, ig_reach: null,
      };
      f.posts += 1;
      if (r.network === 'tg' && r.tg_views != null) f.tg_views = (f.tg_views || 0) + Number(r.tg_views);
      if (r.network === 'ig' && r.ig_reach != null) f.ig_reach = (f.ig_reach || 0) + Number(r.ig_reach);
      byFormat.set(fk, f);
    }

    // Динамика по дням публикации; посты без даты в таймлайн не попадают (считаются отдельно).
    const timeline = new Map();
    let undated = 0;
    for (const r of acc) {
      const day = dayOf(r.published_at);
      if (!day) { undated += 1; continue; }
      const t = timeline.get(day) || { day, posts: 0, tg_views: null, ig_reach: null };
      t.posts += 1;
      if (r.network === 'tg' && r.tg_views != null) t.tg_views = (t.tg_views || 0) + Number(r.tg_views);
      if (r.network === 'ig' && r.ig_reach != null) t.ig_reach = (t.ig_reach || 0) + Number(r.ig_reach);
      timeline.set(day, t);
    }

    // Окно кампании: заданные даты, иначе — фактический диапазон публикаций.
    const dates = acc.map((r) => dayOf(r.published_at)).filter(Boolean).sort();
    const from = campaign.start_date || dates[0] || null;
    const to = campaign.end_date || dates[dates.length - 1] || null;

    // TG-бейзлайн: посты ТЕХ ЖЕ источников за предыдущее равное окно, БЕЗ постов кампании.
    let comparison = { available: false, reason: 'insufficient_data' };
    if (from && to && tgRows.length) {
      const fromMs = Date.parse(`${from}T00:00:00Z`);
      const toMs = Date.parse(`${to}T00:00:00Z`) + 86400000; // exclusive
      const lenMs = Math.max(86400000, toMs - fromMs);
      const prevFrom = new Date(fromMs - lenMs).toISOString();
      const prevTo = new Date(fromMs).toISOString();
      const prevViews = [];
      const tgChannels = [...new Set(tgRows.map((r) => r.channel_id))];
      for (const chId of tgChannels) {
        const excluded = tgRows.filter((r) => r.channel_id === chId).map((r) => r.post_ref);
        const { rows: prevRows } = await pool.query(
          `SELECT views FROM (
             SELECT DISTINCT ON (p.post_id) p.post_id, p.views, p.updated_at
               FROM posts p
               JOIN channels c ON c.id = $1 AND c.status <> 'disabled'
                    AND ${channelAccessSql({ channelAlias: 'c', uidParam: '$2' })}
              WHERE ((c.source_id IS NOT NULL AND p.source_id = c.source_id AND ${sameTenantSource('p', 'c')})
                     OR p.channel_id = c.id)
                AND p.date_published >= $3::timestamptz AND p.date_published < $4::timestamptz
                AND NOT (p.post_id = ANY($5::bigint[]))
              ORDER BY p.post_id, p.updated_at DESC NULLS LAST
           ) latest WHERE views IS NOT NULL`,
          [chId, uid, prevFrom, prevTo, excluded]);
        for (const r of prevRows) prevViews.push(Number(r.views));
      }
      if (prevViews.length >= 3) {
        const prevAvg = round1(sum(prevViews) / prevViews.length);
        comparison = {
          available: true,
          network: 'tg',
          prev_from: prevFrom.slice(0, 10),
          prev_to: prevTo.slice(0, 10),
          prev_posts: prevViews.length,
          prev_views_avg: prevAvg,
          prev_views_median: median(prevViews),
          views_avg_delta_pct: tg.avg != null && prevAvg > 0 ? round1(((tg.avg - prevAvg) / prevAvg) * 100) : null,
        };
      }
    }

    return {
      campaign,
      posts_total: rows.length,
      inaccessible_posts: rows.length - acc.length,
      undated_posts: undated,
      period: { from, to },
      tg,
      ig,
      by_source: [...bySource.values()].sort((a, b) => b.posts - a.posts),
      by_format: [...byFormat.values()].sort((a, b) => b.posts - a.posts),
      timeline: [...timeline.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      comparison,
    };
  }

  return {
    CAMPAIGN_STATUSES, CAMPAIGN_NETWORKS, CAMPAIGN_POSTS_LIMIT, CAMPAIGN_BATCH_LIMIT,
    listCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign,
    addCampaignPosts, removeCampaignPosts, listCampaignPosts, getCampaignSummary,
  };
}

module.exports = { createCampaignsRepo };
