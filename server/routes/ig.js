'use strict';

/**
 * Instagram data routes (/api/ig/{profile,tags,insights,posts,breakdowns,online,stories,history})
 * plus the per-request resolveIg middleware — extracted verbatim from index.js.
 *
 * These routes and the daily IG collection cron (which stays in index.js) both drive graph.instagram.com
 * through the same singleflight igFetch + opportunistic token refresh; those two — plus igConfigured,
 * the env single-account fallback (IG_ACCOUNT/IG_TOKEN) and igCrypto — are shared state and are injected,
 * NOT duplicated. STORY_METRICS / igMetricVal (the story-insight metric list + value parser) live inline
 * here as they did in the route block; the cron keeps its own copies (cf. the existing tvNames vs the
 * cron's own metric list). igMock backs the no-credentials fallback; nearestOf snaps user params to a
 * small enum before the cache key so an arbitrary value can't multiply Graph quota burn.
 */
function registerIgRoutes({
  app, requireAuth, db, log,
  igFetch, refreshIgIfNeeded, igConfigured, igCrypto, igMock, nearestOf,
  cacheGet, cacheSet, IG_ACCOUNT, IG_TOKEN,
}) {
  // Per-request IG identity: resolve { accountId, token, source } for THIS request's channel.
  // Priority: (1) the channel's own OAuth token from ig_accounts (decrypted + refreshed);
  // (2) the global env single-account token; (3) null → the route serves mock. Unlike
  // resolveChannel it never short-circuits on a missing channel and never 500s on a decrypt
  // failure — the IG UI must always render (real, env-fallback, or mock). Requires requireAuth
  // upstream (uses req.user for the channel ownership check).
  async function resolveIg(req, res, next) {
    req.ig = null;
    try {
      const channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
      if (db.enabled && channelId && igCrypto.configured()) {
        const ch  = await db.getChannel(channelId, req.user).catch(() => null);
        const acc = ch ? await db.getIgAccount(channelId).catch(() => null) : null;
        if (acc && acc.access_token_enc) {
          try {
            let token = igCrypto.decrypt(acc.access_token_enc);
            token = await refreshIgIfNeeded(channelId, token, acc.token_expires_at);
            req.ig = { accountId: acc.ig_user_id, token, source: 'channel', channelId, username: acc.username };
          } catch (e) {
            log('warn', 'ig_token_decrypt_failed', { channelId, error: e.message });   // fall through to env/mock
          }
        }
      }
      // Env single-account fallback = the superuser's own account (@bynotem via IG_ACCESS_TOKEN). Gate
      // it to the superuser (or local dev with no DB): a regular user requesting a channel they don't
      // own must NOT be served the env account's real data — they get mock (the connect prompt). This
      // closes the X-Channel-Id spoof where getChannel() denies but the code fell through to env.
      if (!req.ig && igConfigured() && (!db.enabled || (req.user && req.user.role === 'superuser'))) {
        req.ig = { accountId: IG_ACCOUNT, token: IG_TOKEN, source: 'env', channelId: null };
      }
    } catch (e) {
      log('warn', 'resolve_ig_failed', { error: e.message });
    }
    next();
  }

  // GET /api/ig/profile — профиль аккаунта (теперь с аватаркой)
  app.get('/api/ig/profile', requireAuth, resolveIg, async (req, res, next) => {
    try {
      if (!req.ig) return res.json(igMock.igMockProfile());
      const cacheKey = `ig:profile:${req.ig.accountId}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      const data = await igFetch(`/${req.ig.accountId}`, {
        fields: 'username,name,followers_count,follows_count,media_count,biography,website,profile_picture_url'
      }, req.ig.token);
      // Real last-sync time: when we actually fetched from Instagram. Lives in the cached payload (10m
      // TTL), so the UI shows the true sync moment, not when React Query happened to receive a response.
      data.synced_at = Date.now();
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ig/tags — media where the account is @-tagged (the brand-mentions surface; there is no
  // keyword search on Instagram). The live edge only returns recent items, so we archive them in
  // `ig_tags` and serve the accumulated history (DB) — they persist even after the live window drops
  // them. Degrades to mock samples without a token, and to live-only without a DB.
  app.get('/api/ig/tags', requireAuth, resolveIg, async (req, res) => {
    try {
      if (!req.ig) return res.json(igMock.igMockTags());
      let live = [];
      try {
        const r = await igFetch(`/${req.ig.accountId}/tags`, {
          fields: 'id,caption,username,permalink,timestamp,media_type,like_count,comments_count',
          limit: 50,
        }, req.ig.token);
        live = r.data || [];
      } catch { /* tags edge can be empty / unavailable — fall back to the archive */ }
      // The ig_tags archive is global (not yet per-channel), so only archive + serve it for the
      // global env account; per-channel connections serve the live window only until ig_tags is
      // keyed by channel (avoids cross-channel tag leakage).
      const useArchive = db.enabled && req.ig.source === 'env';
      if (useArchive && live.length) await db.upsertIgTags(live).catch(() => {});
      const data = useArchive ? await db.getIgTags(100).catch(() => live) : live;
      res.json({ data, live_count: live.length });
    } catch (e) {
      res.status(200).json({ data: [], error: e.message }); // section degrades, page survives
    }
  });

  // GET /api/ig/insights?days=30 — метрики аккаунта
  app.get('/api/ig/insights', requireAuth, resolveIg, async (req, res, next) => {
    // Snap to a small enum before the cache key: an arbitrary user-supplied `days`
    // would mint per-value cache entries, each costing the full ~19-call Graph burst.
    const days = nearestOf(parseInt(req.query.days, 10) || 30, [7, 30, 90]);

    try {
      if (!req.ig) return res.json(igMock.igMockInsights(days));
      const cacheKey = `ig:insights:${req.ig.accountId}:${days}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      const SEC = 86400;
      const now = Math.floor(Date.now() / 1000);
      const curUntil = now, curSince = now - days * SEC;
      const prevUntil = curSince, prevSince = curSince - days * SEC;

      // Instagram API with Instagram Login (graph.instagram.com): only `reach` + `follower_count`
      // return a daily time-series. Fetch the full 90-day series so the panel can window the
      // selected period (cur vs prev) for these as before.
      const dailyCall = igFetch(`/${req.ig.accountId}/insights`, { metric: 'reach,follower_count', period: 'day', since: now - 90 * SEC, until: now }, req.ig.token);

      // Engagement/visibility metrics are window AGGREGATES (total_value) with no daily series, so
      // they can't be windowed client-side. Fetch each for the current and previous selected window
      // (per-metric allSettled → one unsupported metric, e.g. profile_views, can't blank the rest),
      // then re-shape each as two synthetic daily points (prev-window + current-window) placed inside
      // those windows, so the panel's existing windowPair() KPI/delta math reads them unchanged.
      const tvNames = ['views', 'profile_views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares'];
      const tvVal = (r) => { const m = r && r.data && r.data[0]; return m && m.total_value && m.total_value.value != null ? m.total_value.value : null; };
      const fetchTv = (s, u) => Promise.allSettled(
        tvNames.map((metric) => igFetch(`/${req.ig.accountId}/insights`, { metric, metric_type: 'total_value', period: 'day', since: s, until: u }, req.ig.token)),
      );
      // follows_and_unfollows → real gross follows (FOLLOWER) AND unfollows (NON_FOLLOWER) for the
      // window (period aggregate only — the daily breakdown is empty). Surfaced as `follows`/`unfollows`
      // so the panel can show the channel's REAL movement (net = follows − unfollows), not just gross
      // new follows (which the dashboard previously reported as growth, ignoring unfollows).
      const fetchFau = (s, u) =>
        igFetch(`/${req.ig.accountId}/insights`, { metric: 'follows_and_unfollows', metric_type: 'total_value', breakdown: 'follow_type', period: 'day', since: s, until: u }, req.ig.token);
      const fauVal = (res) => {
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
      // Reach as a DEDUPLICATED window aggregate (total_value) for the current + previous window —
      // Instagram's real "Accounts reached". The daily `reach` series above is a per-day unique count
      // whose naïve sum double-counts repeat viewers (2–4× inflation vs the app). Surfaced under a
      // distinct name (`reach_window`) so it never shadows the daily series the reach chart still needs.
      const fetchReachWin = (s, u) => igFetch(`/${req.ig.accountId}/insights`, { metric: 'reach', metric_type: 'total_value', period: 'day', since: s, until: u }, req.ig.token);
      const [dailyR, curR, prevR, fauCurR, fauPrevR, reachWinCurR, reachWinPrevR] = await Promise.all([
        dailyCall.catch(() => null),
        fetchTv(curSince, curUntil),
        fetchTv(prevSince, prevUntil),
        fetchFau(curSince, curUntil).catch(() => null),
        fetchFau(prevSince, prevUntil).catch(() => null),
        fetchReachWin(curSince, curUntil).catch(() => null),
        fetchReachWin(prevSince, prevUntil).catch(() => null),
      ]);
      const out = dailyR && dailyR.data ? [...dailyR.data] : [];
      const curPoint = new Date(curUntil * 1000).toISOString();
      const prevPoint = new Date((prevSince + Math.floor((days * SEC) / 2)) * 1000).toISOString();
      const pushAgg = (metric, cur, prev) => {
        if (cur == null && prev == null) return;
        const values = [];
        if (prev != null) values.push({ value: prev, end_time: prevPoint });
        if (cur != null) values.push({ value: cur, end_time: curPoint });
        out.push({ name: metric, period: 'day', values, total_value: { value: cur } });
      };
      tvNames.forEach((metric, i) => {
        pushAgg(
          metric,
          curR[i].status === 'fulfilled' ? tvVal(curR[i].value) : null,
          prevR[i].status === 'fulfilled' ? tvVal(prevR[i].value) : null,
        );
      });
      const fauCur = fauVal(fauCurR), fauPrev = fauVal(fauPrevR);
      pushAgg('follows', fauCur.follows, fauPrev.follows);
      pushAgg('unfollows', fauCur.unfollows, fauPrev.unfollows);
      pushAgg('reach_window', tvVal(reachWinCurR), tvVal(reachWinPrevR));
      const data = { data: out };
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ig/posts?limit=20 — последние посты с инсайтами и превью
  app.get('/api/ig/posts', requireAuth, resolveIg, async (req, res, next) => {
    // Snap to a small enum before the cache key (each post costs its own insights call,
    // so per-value cache entries multiply Graph quota burn).
    const limit = nearestOf(parseInt(req.query.limit, 10) || 20, [6, 12, 25]);
    try {
      if (!req.ig) return res.json(igMock.igMockPosts(limit));
      const cacheKey = `ig:posts:${req.ig.accountId}:${limit}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      const mediaRes = await igFetch(`/${req.ig.accountId}/media`, {
        fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
        limit
      }, req.ig.token);

      const posts = await Promise.all(
        (mediaRes.data || []).map(async (post) => {
          // impressions deprecated 2025 → views. Reels carry watch-time (ms), only valid on REELS.
          const base = 'reach,views,shares,saved,total_interactions';
          const metric = post.media_product_type === 'REELS'
            ? `${base},ig_reels_avg_watch_time,ig_reels_video_view_total_time`
            : base;
          try {
            const ins = await igFetch(`/${post.id}/insights`, { metric, metric_type: 'total_value' }, req.ig.token);
            const metrics = {};
            (ins.data || []).forEach((m) => {
              metrics[m.name] = (m.total_value && m.total_value.value != null)
                ? m.total_value.value
                : (m.values && m.values[0] ? m.values[0].value : 0);
            });
            return { ...post, ...metrics };
          } catch {
            return post;
          }
        })
      );

      const result = { data: posts };
      cacheSet(cacheKey, result);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // GET /api/ig/breakdowns — audience demographics + format/contact breakdowns (modern
  // total_value envelope, Graph v22+). Mock-backed when no creds.
  app.get('/api/ig/breakdowns', requireAuth, resolveIg, async (req, res) => {
    const allowed = ['last_14_days', 'last_30_days', 'last_90_days'];
    const timeframe = allowed.includes(req.query.timeframe) ? req.query.timeframe : 'last_30_days';
    try {
      if (!req.ig) return res.json(igMock.igMockBreakdowns(timeframe));
      const cacheKey = `ig:breakdowns:${req.ig.accountId}:${timeframe}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const calls = [
        { metric: 'follower_demographics', breakdown: 'age', period: 'lifetime', metric_type: 'total_value', timeframe },
        { metric: 'follower_demographics', breakdown: 'gender', period: 'lifetime', metric_type: 'total_value', timeframe },
        { metric: 'follower_demographics', breakdown: 'country', period: 'lifetime', metric_type: 'total_value', timeframe },
        { metric: 'follower_demographics', breakdown: 'city', period: 'lifetime', metric_type: 'total_value', timeframe },
        { metric: 'total_interactions', breakdown: 'media_product_type', period: 'day', metric_type: 'total_value' },
        { metric: 'profile_links_taps', breakdown: 'contact_button_type', period: 'day', metric_type: 'total_value' },
      ];
      const settled = await Promise.allSettled(
        calls.map((c) => igFetch(`/${req.ig.accountId}/insights`, c, req.ig.token)),
      );
      const data = settled
        .filter((s) => s.status === 'fulfilled')
        .flatMap((s) => s.value?.data || []);
      const result = { data };
      cacheSet(cacheKey, result);
      res.json(result);
    } catch (e) {
      res.status(200).json({ data: [], error: e.message }); // graceful: section degrades, page survives
    }
  });

  // GET /api/ig/online — online-followers hourly map (best-time heatmap). Flaky metric →
  // always 200, empty data[] on failure so the heatmap degrades instead of crashing.
  app.get('/api/ig/online', requireAuth, resolveIg, async (req, res) => {
    try {
      if (!req.ig) return res.json(igMock.igMockOnlineFollowers());
      const cacheKey = `ig:online:${req.ig.accountId}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const data = await igFetch(`/${req.ig.accountId}/insights`, { metric: 'online_followers', period: 'lifetime' }, req.ig.token);
      const result = { data: data?.data || [] };
      cacheSet(cacheKey, result);
      res.json(result);
    } catch (e) {
      res.status(200).json({ data: [], error: e.message });
    }
  });

  // GET /api/ig/stories — active stories (last 24h) + per-story insights/navigation. Cached
  // briefly (3 min): the fan-out costs 1+~8 Graph calls PER STORY, so serving it uncached on
  // every view self-burns the quota; tolerates per-story errors (#10 <5 viewers), returns []
  // gracefully. Per-story metrics fetched INDEPENDENTLY (allSettled): on the Instagram-Login API a single
  // unsupported story metric makes a *combined* /insights call fail wholesale, which previously
  // dropped the entire story to null → the section showed "no stories" even when stories existed.
  const STORY_METRICS = ['reach', 'views', 'replies', 'shares', 'follows', 'profile_visits', 'total_interactions'];
  const igMetricVal = (j) => {
    const m = j && j.data && j.data[0];
    if (!m) return null;
    if (m.total_value && m.total_value.value != null) return m.total_value.value;
    if (m.values && m.values[0] && m.values[0].value != null) return m.values[0].value;
    return null;
  };

  const IG_STORIES_TTL = 180 * 1000;

  app.get('/api/ig/stories', requireAuth, resolveIg, async (req, res) => {
    try {
      if (!req.ig) return res.json(igMock.igMockStories());
      const cacheKey = `ig:stories:${req.ig.accountId}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const list = await igFetch(`/${req.ig.accountId}/stories`, {
        fields: 'id,media_type,timestamp,permalink,thumbnail_url',
      }, req.ig.token);
      const stories = await Promise.all(
        (list.data || []).map(async (s) => {
          const out = { ...s };
          // Each metric independently — one unsupported metric blanks only itself; the story and
          // its remaining metrics always survive (the story is never dropped).
          const settled = await Promise.allSettled(
            STORY_METRICS.map((metric) => igFetch(`/${s.id}/insights`, { metric, metric_type: 'total_value' }, req.ig.token)),
          );
          settled.forEach((r, i) => {
            if (r.status !== 'fulfilled') return;
            const v = igMetricVal(r.value);
            if (v != null) out[STORY_METRICS[i]] = v;
          });
          // Navigation breakdown (tap_forward/back/exit, swipe_forward) — isolated so a breakdown
          // failure can't blank the numeric metrics above.
          try {
            const navRes = await igFetch(`/${s.id}/insights`, {
              metric: 'navigation', metric_type: 'total_value', breakdown: 'story_navigation_action_type',
            }, req.ig.token);
            const m = (navRes.data || []).find((x) => x.name === 'navigation');
            if (m && m.total_value) {
              const block = m.total_value.breakdowns && m.total_value.breakdowns[0];
              if (block) {
                const nav = {};
                (block.results || []).forEach((r) => {
                  const k = r.dimension_values && r.dimension_values[0];
                  if (k) nav[k] = r.value;
                });
                out.navigation = nav;
              }
              out.navigation_total = m.total_value.value != null ? m.total_value.value : 0;
            }
          } catch { /* navigation optional */ }
          // Derive total_interactions if the metric itself was unsupported for this media type.
          if (out.total_interactions == null) {
            out.total_interactions = Number(out.replies || 0) + Number(out.shares || 0);
          }
          return out;
        }),
      );
      const result = { data: stories }; // never filter — a story must survive insight failures
      cacheSet(cacheKey, result, IG_STORIES_TTL);
      res.json(result);
    } catch (e) {
      res.status(200).json({ data: [], error: e.message });
    }
  });

  // GET /api/ig/history?days=400 — persisted daily IG series (Postgres ig_daily), mirroring
  // /api/history/channel for TG. This is the DB-first read path: IG's live window is tiny (~30d for
  // follower_count, nothing for reach beyond the API cap), so the accumulated history lives here.
  // resolveIg gives us req.ig.channelId ONLY after getChannel() passed (ownership enforced) — so we
  // serve history for the requester's own connected channel and no one else's. The env/mock fallback
  // (channelId null) has no per-channel rows → [] → the client transparently keeps its live series.
  app.get('/api/ig/history', requireAuth, resolveIg, async (req, res) => {
    const days = Math.min(1000, parseInt(req.query.days, 10) || 400);
    const channelId = req.ig && req.ig.channelId;
    try {
      res.json({ enabled: db.enabled, rows: channelId ? await db.listIgDailyForActor(channelId, req.user, days) : [] });
    } catch (e) {
      res.status(200).json({ enabled: db.enabled, rows: [], error: e.message });
    }
  });
}

module.exports = { registerIgRoutes };
