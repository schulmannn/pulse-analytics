// ═══════════════════════════════════════════════════════════════
//  Pulse Analytics — Backend Server
//  Node.js + Express
//  Запуск: node server/index.js
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting — защита от спама
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100,
  message: { error: 'Слишком много запросов. Попробуй через 15 минут.' }
});
app.use('/api/', limiter);

// ── Простая in-memory авторизация ───────────────────────────────
// Команда вводит пароль → получает токен на 8 часов
const sessions = new Map(); // token → { expires }

function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });

  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Сессия истекла, войди снова' });
  }
  next();
}

// ── In-memory кэш ───────────────────────────────────────────────
// Чтобы не долбить API при каждом обновлении страницы
const cache = new Map(); // key → { data, expires }
const CACHE_TTL = 10 * 60 * 1000; // 10 минут

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

// POST /api/auth/login  { password }
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Укажи пароль' });

  if (password !== process.env.TEAM_PASSWORD) {
    return res.status(403).json({ error: 'Неверный пароль' });
  }

  const token   = generateToken();
  const expires = Date.now() + 8 * 60 * 60 * 1000; // 8 часов
  sessions.set(token, { expires });

  res.json({ token, expiresAt: new Date(expires).toISOString() });
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, (req, res) => {
  sessions.delete(req.headers['x-session-token']);
  res.json({ ok: true });
});

// GET /api/auth/check  — проверка сессии
app.get('/api/auth/check', requireAuth, (req, res) => {
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
//  INSTAGRAM ROUTES
//  Документация: https://developers.facebook.com/docs/instagram-api
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

// GET /api/ig/profile — профиль аккаунта
app.get('/api/ig/profile', requireAuth, async (req, res) => {
  try {
    const cached = cacheGet('ig:profile');
    if (cached) return res.json(cached);

    const data = await igFetch(`/${IG_ACCOUNT}`, {
      fields: 'username,name,followers_count,follows_count,media_count,biography,website'
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

// GET /api/ig/posts?limit=20 — последние посты с инсайтами
app.get('/api/ig/posts', requireAuth, async (req, res) => {
  const limit = Math.min(25, parseInt(req.query.limit) || 20);
  const cacheKey = `ig:posts:${limit}`;
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // 1. Список постов
    const mediaRes = await igFetch(`/${IG_ACCOUNT}/media`, {
      fields: 'id,caption,media_type,timestamp,like_count,comments_count',
      limit
    });

    // 2. Инсайты по каждому посту параллельно
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
//  TELEGRAM — Bot API (базовые данные)
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

// GET /api/tg/channel — базовая информация о канале (Bot API)
app.get('/api/tg/channel', requireAuth, async (req, res) => {
  try {
    const cached = cacheGet('tg:channel');
    if (cached) return res.json(cached);

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
      inviteLink:  chat.invite_link || null,
      source:      'bot_api',
    };
    cacheSet('tg:channel', data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  TELEGRAM — MTProto прокси (реальная аналитика)
//  Python-сервис слушает на MTPROTO_PORT (по умолчанию 8001)
//  Node.js проксирует запросы к нему, добавляя внутренний токен
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

// GET /api/tg/mtproto/health — статус Python-сервиса
app.get('/api/tg/mtproto/health', requireAuth, async (req, res) => {
  try {
    const data = await mtprotoFetch('/health');
    res.json({ available: true, ...data });
  } catch (e) {
    res.json({ available: false, error: e.message });
  }
});

// GET /api/tg/mtproto/channel — полная информация о канале через MTProto
app.get('/api/tg/mtproto/channel', requireAuth, async (req, res) => {
  const cacheKey = 'mtproto:channel';
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await mtprotoFetch('/channel');
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, hint: 'MTProto сервис недоступен — запусти mtproto/service.py' });
  }
});

// GET /api/tg/mtproto/posts?limit=30&offset_id=0 — посты с РЕАЛЬНЫМИ просмотрами
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
    res.status(500).json({ error: e.message, hint: 'MTProto сервис недоступен — запусти mtproto/service.py' });
  }
});

// GET /api/tg/mtproto/views_summary?limit=30 — агрегированная сводка просмотров
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
    res.status(500).json({ error: e.message, hint: 'MTProto сервис недоступен — запусти mtproto/service.py' });
  }
});

// GET /api/tg/mtproto/stats — нативная статистика Telegram (500+ подп.)
app.get('/api/tg/mtproto/stats', requireAuth, async (req, res) => {
  const cacheKey = 'mtproto:stats';
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await mtprotoFetch('/stats');
    cacheSet(cacheKey, data);
    res.json(data);
  } catch (e) {
    // Это необязательный эндпоинт — не ломаем всё если недоступен
    res.status(200).json({
      error:     e.message,
      available: false,
      hint:      'Статистика доступна только для каналов с 500+ подписчиков с включённой статистикой'
    });
  }
});

// GET /api/tg/full — всё сразу: Bot API + MTProto (для первичной загрузки дашборда)
app.get('/api/tg/full', requireAuth, async (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  try {
    // Запускаем Bot API и MTProto параллельно
    const [botChannel, mtChannel, viewsSummary, posts] = await Promise.allSettled([
      // Bot API — всегда доступен
      (async () => {
        const [chat, count] = await Promise.all([
          tgFetch('getChat',            { chat_id: TG_CHANNEL }),
          tgFetch('getChatMemberCount', { chat_id: TG_CHANNEL }),
        ]);
        return { title: chat.title, username: chat.username, description: chat.description || '', memberCount: count };
      })(),
      // MTProto — может быть недоступен
      mtprotoFetch('/channel'),
      mtprotoFetch('/views_summary', { limit }),
      mtprotoFetch('/posts', { limit }),
    ]);

    const bot  = botChannel.status  === 'fulfilled' ? botChannel.value  : null;
    const mtp  = mtChannel.status   === 'fulfilled' ? mtChannel.value   : null;
    const vs   = viewsSummary.status=== 'fulfilled' ? viewsSummary.value: null;
    const ps   = posts.status       === 'fulfilled' ? posts.value       : null;

    res.json({
      // Объединяем: MTProto данные приоритетнее Bot API там где пересекаются
      channel: {
        ...(bot || {}),
        ...(mtp || {}),
        // memberCount из Bot API надёжнее
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

// GET /api/health — статус сервера
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    cache:  cache.size,
    sessions: sessions.size,
    env: {
      ig:  !!IG_TOKEN && !!IG_ACCOUNT,
      tg:  !!TG_TOKEN && !!TG_CHANNEL,
      auth: !!process.env.TEAM_PASSWORD
    }
  });
});

// DELETE /api/cache — сброс кэша (только авторизованным)
app.delete('/api/cache', requireAuth, (req, res) => {
  cache.clear();
  res.json({ ok: true, message: 'Кэш сброшен' });
});

// SPA fallback — отдаём index.html для всех неизвестных маршрутов
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
