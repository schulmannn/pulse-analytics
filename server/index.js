// ═══════════════════════════════════════════════════════════════
//  Pulse Analytics — Backend Server
//  Node.js + Express
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const db         = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// История (Postgres) — поднимаем схему, если БД подключена; иначе тихо выключено.
db.init().catch(e => console.error('[db] init failed:', e.message));

// ── Middleware ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Слишком много запросов. Попробуй через 15 минут.' }
});
app.use('/api/', limiter);

// ── Авторизация: stateless HMAC-токены (переживают рестарт/редеплой) ──
const crypto = require('crypto');
const AUTH_SECRET = process.env.TEAM_PASSWORD || 'pulse-dev-secret';

function signToken(expires) {
  const payload = String(expires);
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return false;
  const [p, sig] = token.split('.');
  let payload;
  try { payload = Buffer.from(p, 'base64url').toString('utf8'); } catch (e) { return false; }
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  if (!sig || sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const expires = parseInt(payload, 10);
  return !!expires && expires > Date.now();
}

function requireAuth(req, res, next) {
  if (!verifyToken(req.headers['x-session-token'])) {
    return res.status(401).json({ error: 'Сессия истекла, войди снова' });
  }
  next();
}

// ── In-memory кэш ───────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || entry.expires < Date.now()) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL });
}

// ════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════════

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Укажи пароль' });

  if (password !== process.env.TEAM_PASSWORD) {
    return res.status(403).json({ error: 'Неверный пароль' });
  }

  const expires = Date.now() + 8 * 60 * 60 * 1000;
  const token   = signToken(expires);

  res.json({ token, expiresAt: new Date(expires).toISOString() });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  // stateless — клиент просто удаляет токен у себя
  res.json({ ok: true });
});

app.get('/api/auth/check', requireAuth, (req, res) => {
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
//  INSTAGRAM ROUTES
// ════════════════════════════════════════════════════════════════

const IG_BASE      = 'https://graph.facebook.com/v19.0';
const IG_TOKEN     = process.env.IG_ACCESS_TOKEN;
const IG_ACCOUNT   = process.env.IG_ACCOUNT_ID;

async function igFetch(path, params = {}) {
  params.access_token = IG_TOKEN;
  const qs  = new URLSearchParams(params).toString();
  const url = `${IG_BASE}${path}?${qs}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`Instagram API: ${json.error.message}`);
  return json;
}

// GET /api/ig/profile — профиль аккаунта (теперь с аватаркой)
app.get('/api/ig/profile', requireAuth, async (req, res) => {
  try {
    const cached = cacheGet('ig:profile');
    if (cached) return res.json(cached);

    const data = await igFetch(`/${IG_ACCOUNT}`, {
      fields: 'username,name,followers_count,follows_count,media_count,biography,website,profile_picture_url'
    });
    cacheSet('ig:profile', data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ig/insights?days=30 — метрики аккаунта
app.get('/api/ig/insights', requireAuth, async (req, res) => {
  const days = Math.min(90, parseInt(req.query.days) || 30);
  const cacheKey = `ig:insights:${days}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const until = Math.floor(Date.now() / 1000);

    const data = await igFetch(`/${IG_ACCOUNT}/insights`, {
      metric: 'reach,impressions,profile_views,follower_count,website_clicks',
      period: 'day',
      since,
      until
    });
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ig/posts?limit=20 — последние посты с инсайтами и превью
app.get('/api/ig/posts', requireAuth, async (req, res) => {
  const limit = Math.min(25, parseInt(req.query.limit) || 20);
  const cacheKey = `ig:posts:${limit}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const mediaRes = await igFetch(`/${IG_ACCOUNT}/media`, {
      fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
      limit
    });

    const posts = await Promise.all(
      (mediaRes.data || []).map(async (post) => {
        try {
          const ins = await igFetch(`/${post.id}/insights`, {
            metric: 'reach,impressions,shares,saved'
          });
          const metrics = {};
          (ins.data || []).forEach(m => {
            metrics[m.name] = m.values?.[0]?.value || 0;
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
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  TELEGRAM — Bot API
// ════════════════════════════════════════════════════════════════

const TG_BASE    = 'https://api.telegram.org/bot';
const TG_TOKEN   = process.env.TG_BOT_TOKEN;
const TG_CHANNEL = process.env.TG_CHANNEL;

async function tgFetch(method, params = {}) {
  const url = new URL(`${TG_BASE}${TG_TOKEN}/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res  = await fetch(url.toString());
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram API: ${json.description}`);
  return json.result;
}

app.get('/api/tg/channel', requireAuth, async (req, res) => {
  try {
    const cached = cacheGet('tg:channel');
    if (cached) return res.json(cached);

    // Основной источник — Bot API (только если задан токен бота)
    if (TG_TOKEN) {
      try {
        const [chat, memberCount] = await Promise.all([
          tgFetch('getChat',            { chat_id: TG_CHANNEL }),
          tgFetch('getChatMemberCount', { chat_id: TG_CHANNEL })
        ]);
        const data = {
          id:          chat.id,
          title:       chat.title,
          username:    chat.username,
          description: chat.description || '',
          memberCount,
          online:      0,
          inviteLink:  chat.invite_link || null,
          source:      'bot_api',
        };
        cacheSet('tg:channel', data);
        return res.json(data);
      } catch (_botErr) {
        // бот недоступен → падаем в MTProto-фолбэк ниже
      }
    }

    // Фолбэк — MTProto через твой личный аккаунт (работает без бота)
    const mt = await mtprotoFetch('/channel');
    const data = {
      id:          mt.id,
      title:       mt.title,
      username:    mt.username,
      description: mt.description || '',
      memberCount: mt.members || 0,
      online:      mt.online || 0,
      inviteLink:  null,
      source:      'mtproto',
    };
    cacheSet('tg:channel', data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  TELEGRAM — MTProto прокси
// ════════════════════════════════════════════════════════════════

const MTPROTO_URL  = process.env.MTPROTO_URL || 'http://localhost:8001';
const MTPROTO_PASS = process.env.TEAM_PASSWORD || '';

async function mtprotoFetch(path, params = {}) {
  const url = new URL(MTPROTO_URL + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res  = await fetch(url.toString(), {
    headers: { 'x-internal-token': MTPROTO_PASS }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `MTProto error ${res.status}`);
  }
  return res.json();
}

app.get('/api/tg/mtproto/health', requireAuth, async (req, res) => {
  try {
    const data = await mtprotoFetch('/health');
    res.json({ available: true, ...data });
  } catch (e) {
    res.json({ available: false, error: e.message });
  }
});

app.get('/api/tg/mtproto/channel', requireAuth, async (req, res) => {
  const cacheKey = 'mtproto:channel';
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/channel');
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, hint: 'MTProto сервис недоступен' });
  }
});

app.get('/api/tg/mtproto/posts', requireAuth, async (req, res) => {
  const limit     = Math.min(100, parseInt(req.query.limit)     || 30);
  const offsetId  = parseInt(req.query.offset_id) || 0;
  const cacheKey  = `mtproto:posts:${limit}:${offsetId}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/posts', { limit, offset_id: offsetId });
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, hint: 'MTProto сервис недоступен' });
  }
});

app.get('/api/tg/mtproto/views_summary', requireAuth, async (req, res) => {
  const limit    = Math.min(100, parseInt(req.query.limit) || 30);
  const cacheKey = `mtproto:views:${limit}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/views_summary', { limit });
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, hint: 'MTProto сервис недоступен' });
  }
});

app.get('/api/tg/mtproto/stats', requireAuth, async (req, res) => {
  const cacheKey = 'mtproto:stats';
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/stats');
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(200).json({
      error:     e.message,
      available: false,
      hint:      'Статистика доступна только для каналов с 500+ подписчиков'
    });
  }
});

app.get('/api/tg/mtproto/graphs', requireAuth, async (req, res) => {
  const cacheKey = 'mtproto:graphs';
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/graphs');
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(200).json({ error: e.message, available: false });
  }
});

app.get('/api/tg/mtproto/velocity', requireAuth, async (req, res) => {
  const cacheKey = 'mtproto:velocity';
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/velocity');
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(200).json({ error: e.message, available: false });
  }
});

// Brand mentions — cached longer (searchPosts has a ~10/day free quota) to avoid
// burning it on repeated loads. Cache TTL here is the 10-min default; the Python
// side also checks free quota before each search and never spends Stars.
app.get('/api/tg/mtproto/mentions', requireAuth, async (req, res) => {
  const cacheKey = 'mtproto:mentions';
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/mentions');
    if (data && data.available) {
      // accumulate the full deduped list into the archive (history beyond searchPosts' window)
      if (Array.isArray(data.all)) {
        db.upsertMentions(data.all).catch(e => console.error('[db] mentions upsert:', e.message));
      }
      delete data.all;                 // don't ship the full list to the client
      cacheSet(cacheKey, data);         // don't cache failures
    }
    res.json(data);
  } catch (e) {
    res.status(200).json({ error: e.message, available: false });
  }
});

app.get('/api/tg/mtproto/post_stats/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const cacheKey = 'mtproto:poststats:' + id;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const data = await mtprotoFetch('/post_stats/' + id);
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(200).json({ available: false, error: e.message });
  }
});

// Post thumbnail (binary) — open route so <img src> works without a header.
// Low sensitivity: only serves thumbnails of the configured (public) channel.
app.get('/api/tg/mtproto/thumb/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).end();
  const size = req.query.size === 'lg' ? 'lg' : 'sm';
  try {
    const r = await fetch(`${MTPROTO_URL}/thumb/${id}?size=${size}`, { headers: { 'x-internal-token': MTPROTO_PASS } });
    if (!r.ok) return res.status(r.status).end();
    const buf = await r.buffer();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(502).end();
  }
});

app.get('/api/tg/full', requireAuth, async (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  try {
    const [botChannel, mtChannel, viewsSummary, posts] = await Promise.allSettled([
      (async () => {
        const [chat, count] = await Promise.all([
          tgFetch('getChat',            { chat_id: TG_CHANNEL }),
          tgFetch('getChatMemberCount', { chat_id: TG_CHANNEL }),
        ]);
        return { title: chat.title, username: chat.username, description: chat.description || '', memberCount: count };
      })(),
      mtprotoFetch('/channel'),
      mtprotoFetch('/views_summary', { limit }),
      mtprotoFetch('/posts', { limit }),
    ]);

    const bot  = botChannel.status  === 'fulfilled' ? botChannel.value  : null;
    const mtp  = mtChannel.status   === 'fulfilled' ? mtChannel.value   : null;
    const vs   = viewsSummary.status=== 'fulfilled' ? viewsSummary.value: null;
    const ps   = posts.status       === 'fulfilled' ? posts.value       : null;

    res.json({
      channel: {
        ...(bot || {}),
        ...(mtp || {}),
        memberCount: bot?.memberCount || mtp?.members || 0,
        source: mtp ? 'mtproto+bot_api' : 'bot_api',
      },
      views_summary:   vs,
      posts:           ps?.posts || [],
      mtproto_available: !!mtp,
      errors: {
        bot:    botChannel.status  === 'rejected' ? botChannel.reason?.message  : null,
        mtp:    mtChannel.status   === 'rejected' ? mtChannel.reason?.message   : null,
        views:  viewsSummary.status=== 'rejected' ? viewsSummary.reason?.message: null,
        posts:  posts.status       === 'rejected' ? posts.reason?.message       : null,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  ОБЩИЕ ROUTES
// ════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    cache:  cache.size,
    sessions: 'stateless',
    env: {
      ig:  !!IG_TOKEN && !!IG_ACCOUNT,
      tg:  !!TG_TOKEN && !!TG_CHANNEL,
      auth: !!process.env.TEAM_PASSWORD
    }
  });
});

app.delete('/api/cache', requireAuth, (req, res) => {
  cache.clear();
  res.json({ ok: true, message: 'Кэш сброшен' });
});

// ════════════════════════════════════════════════════════════════
//  ИСТОРИЯ (Postgres) — снэпшоты сверх 3-месячного окна Telegram
// ════════════════════════════════════════════════════════════════

// Снимок дня: тянет дневные серии из /graphs (+ посты) и upsert'ит в БД.
// Защищён отдельным токеном (НЕ командный пароль) — дёргается cron'ом.
app.post('/api/ingest/daily', async (req, res) => {
  const token = req.query.token || req.headers['x-ingest-token'];
  if (!process.env.INGEST_TOKEN || token !== process.env.INGEST_TOKEN) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  if (!db.enabled) return res.status(200).json({ ok: false, reason: 'DATABASE_URL не задан — БД выключена' });
  try {
    const [graphs, posts] = await Promise.all([
      mtprotoFetch('/graphs', { points: 400 }).catch(() => null),   // full range for the archive (dashboard uses 45)
      mtprotoFetch('/posts', { limit: 100 }).catch(() => null),
    ]);

    const dailyRows = db.graphsToDailyRows(graphs);
    const nDaily = await db.upsertChannelDaily(dailyRows);

    let nPosts = 0;
    if (posts && Array.isArray(posts.posts)) {
      const prows = posts.posts.map(p => {
        const reach = p.views || 0;
        const eng = (p.reactions || 0) + (p.forwards || 0) + (p.replies || 0);
        return {
          post_id: p.id, date_published: p.date,
          views: p.views || 0, reactions: p.reactions || 0, forwards: p.forwards || 0, replies: p.replies || 0,
          erv: reach > 0 ? eng / reach * 100 : null,
          virality: reach > 0 ? (p.forwards || 0) / reach * 100 : null,
          media_type: p.media_type, caption: (p.text || '').slice(0, 500), hashtags: p.hashtags || [],
        };
      });
      nPosts = await db.upsertPosts(prows);
    }
    res.json({ ok: true, channel_daily: nDaily, posts: nPosts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/history/channel', requireAuth, async (req, res) => {
  const days = Math.min(1000, parseInt(req.query.days) || 365);
  try {
    res.json({ enabled: db.enabled, rows: await db.getChannelHistory(days) });
  } catch (e) {
    res.status(200).json({ enabled: db.enabled, rows: [], error: e.message });
  }
});

app.get('/api/history/mentions', requireAuth, async (req, res) => {
  try {
    const h = await db.getMentionsHistory();
    res.json({ enabled: db.enabled, ...(h || {}) });
  } catch (e) {
    res.status(200).json({ enabled: db.enabled, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  БАГ-ТРЕКЕР (Postgres)
// ════════════════════════════════════════════════════════════════
app.post('/api/bugs', requireAuth, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена — баги негде сохранять' });
  const text = ((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'Опиши баг' });
  try {
    const bug = await db.createBug({ text, severity: req.body.severity, context: req.body.context });
    res.json(bug);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bugs', requireAuth, async (req, res) => {
  try {
    res.json({ enabled: db.enabled, statuses: db.BUG_STATUSES, bugs: await db.listBugs(req.query.status) });
  } catch (e) { res.status(200).json({ enabled: db.enabled, bugs: [], error: e.message }); }
});

app.patch('/api/bugs/:id', requireAuth, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try {
    const bug = await db.updateBug(id, (req.body && req.body.status));
    if (!bug) return res.status(404).json({ error: 'not found' });
    res.json(bug);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/bugs/:id', requireAuth, async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'БД не подключена' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad id' });
  try { await db.deleteBug(id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Запуск ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║        Pulse Analytics Server            ║
╠══════════════════════════════════════════╣
║  URL:      http://localhost:${PORT}          ║
║  IG API:   ${IG_TOKEN ? '✅ настроен' : '❌ не задан (IG_ACCESS_TOKEN)'}           ║
║  TG API:   ${TG_TOKEN ? '✅ настроен' : '❌ не задан (TG_BOT_TOKEN)'}             ║
║  Auth:     ${process.env.TEAM_PASSWORD ? '✅ пароль задан' : '❌ TEAM_PASSWORD не задан'}        ║
╚══════════════════════════════════════════╝
  `);
});
