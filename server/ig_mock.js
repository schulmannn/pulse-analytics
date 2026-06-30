'use strict';
// ════════════════════════════════════════════════════════════════
//  INSTAGRAM — deterministic MOCK payloads (current Graph API shapes)
// ════════════════════════════════════════════════════════════════
// Lets us build the IG analytics UI before a real account is connected. The /api/ig/*
// routes fall back to these whenever IG_ACCESS_TOKEN / IG_ACCOUNT_ID are unset, so the
// frontend consumes the exact response shape it will get from the real Graph API (v22+).
// Values are stable per calendar day (seeded), so charts don't jitter on every refresh.
//
// Modeled on the CURRENT API (2025-2026): `impressions` and `website_clicks` are
// DEPRECATED (→ `views` / `profile_links_taps`); demographics use the total_value +
// breakdowns envelope; reels watch-time is in MILLISECONDS.

const seeded = (n) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};
const DAY_MS = 86400000;
const dayIndex = (ms) => Math.floor(ms / DAY_MS);

const FOLLOWERS = 12480;

function igMockProfile() {
  return {
    mock: true,
    id: 'mock_account',
    username: 'pulse.demo',
    name: 'Pulse Demo',
    followers_count: FOLLOWERS,
    follows_count: 312,
    media_count: 248,
    biography: 'Демо-аккаунт для предпросмотра аналитики Pulse',
    website: 'https://atlavue.com',
    profile_picture_url: '',
  };
}

// Account insights — GET /{ig-user}/insights?period=day. Each metric is a daily
// { name, period, values:[{ value, end_time }] } block (the time_series shape the
// frontend metricSeries() reader + charts consume). NOTE: no `impressions`/`website_clicks`
// (dead since 2025) — `views` is the impressions successor.
function igMockInsights(days = 30) {
  const d = Math.min(90, Math.max(1, Number(days) || 30));
  const today = dayIndex(Date.now());

  const buildMetric = (name, base, spread, weekendDamp = true) => {
    const values = [];
    for (let i = d - 1; i >= 0; i--) {
      const idx = today - i;
      const noise = seeded(idx * 7 + name.length);
      const weekday = new Date(idx * DAY_MS).getUTCDay();
      const damp = weekendDamp && (weekday === 0 || weekday === 6) ? 0.78 : 1;
      const value = Math.max(0, Math.round((base + (noise - 0.5) * spread) * damp));
      values.push({ value, end_time: new Date(idx * DAY_MS + 7 * 3600000).toISOString() });
    }
    return { name, period: 'day', title: name, description: 'mock', id: `mock_${name}`, values };
  };

  return {
    mock: true,
    data: [
      buildMetric('reach', 5200, 3400),
      buildMetric('views', 8800, 5200), // successor to impressions
      buildMetric('profile_views', 240, 180),
      buildMetric('follower_count', 55, 90), // daily NET-NEW followers
      buildMetric('accounts_engaged', 900, 600),
      buildMetric('total_interactions', 1300, 800),
      buildMetric('likes', 1050, 650),
      buildMetric('comments', 70, 60),
      buildMetric('saves', 130, 120),
      buildMetric('shares', 90, 90),
      buildMetric('follows', 70, 60), // gross new follows (FOLLOWER)
      buildMetric('unfollows', 48, 44), // gross unfollows (NON_FOLLOWER) — net positive in the demo
    ],
  };
}

const MOCK_CAPTIONS = [
  'Как мы выросли на 40% за квартал — разбор по шагам 📈 #аналитика #рост #smm',
  'Новый дроп уже в профиле. Листай карусель 👉 #продукт #дизайн',
  'Reels недели: за кадром нашей съёмки 🎬 #reels #backstage #контент',
  'Топ-5 ошибок в контент-плане (сохрани) #контент #smm #гайд',
  'Отвечаем на ваши вопросы в комментах 💬 #комьюнити #вопросответ',
  'Гайд: как мы собираем аналитику по всем соцсетям #аналитика #гайд #инструменты',
  'Анонс коллаборации — детали скоро ✨ #коллаборация #анонс',
  'Подводим итоги месяца цифрами #аналитика #итоги',
  'Закулисье: один день из жизни команды #backstage #команда #контент',
  'Мини-кейс: +2.3k охвата с одного поста #кейс #рост #smm',
  'Полезная подборка инструментов для SMM #инструменты #smm #подборка',
  'Спасибо за 12k! Дальше — больше 🚀 #комьюнити #рост',
];
const MEDIA_TYPES = ['IMAGE', 'CAROUSEL_ALBUM', 'REELS', 'VIDEO'];

// Recent media — GET /{ig-user}/media + per-media insights merged in. Reels carry
// watch-time fields (in MILLISECONDS, per the API).
function igMockPosts(limit = 20) {
  const n = Math.min(25, Math.max(1, Number(limit) || 20));
  const now = Date.now();
  const data = [];
  for (let i = 0; i < n; i++) {
    const s1 = seeded(i * 13 + 1);
    const s2 = seeded(i * 29 + 5);
    const type = MEDIA_TYPES[i % MEDIA_TYPES.length];
    const isReel = type === 'REELS';
    const reach = Math.round(3000 + s1 * 14000);
    const views = Math.round(reach * (1.4 + s2 * 0.7));
    const impressions = Math.round(reach * (1.3 + s2 * 0.6)); // legacy field, kept for pre-2025 media
    const likes = Math.round(reach * (0.04 + s2 * 0.06));
    const comments = Math.round(likes * (0.02 + s1 * 0.05));
    const saved = Math.round(likes * (0.05 + s2 * 0.2));
    const shares = Math.round(likes * (0.02 + s1 * 0.08));
    const post = {
      id: `mock_${i}`,
      caption: MOCK_CAPTIONS[i % MOCK_CAPTIONS.length],
      media_type: type,
      media_product_type: isReel ? 'REELS' : 'FEED',
      media_url: '',
      thumbnail_url: '',
      permalink: `https://instagram.com/p/MOCK${i}/`,
      timestamp: new Date(now - Math.round(i * 3.2 * DAY_MS)).toISOString(),
      like_count: likes,
      comments_count: comments,
      reach,
      views,
      impressions,
      shares,
      saved,
      total_interactions: likes + comments + saved + shares,
    };
    if (isReel) {
      const avgWatchMs = Math.round(4000 + s1 * 9000); // 4-13s
      post.ig_reels_avg_watch_time = avgWatchMs;
      post.ig_reels_video_view_total_time = avgWatchMs * views; // total ms watched
    }
    data.push(post);
  }
  return { mock: true, data };
}

// ── total_value + breakdowns envelope (Graph API v22+) ──
// follower_demographics (age/gender/country/city), total_interactions by format,
// profile_links_taps by contact button.
function bd(name, dim, results, period = 'lifetime', topValue) {
  const total_value = { breakdowns: [{ dimension_keys: [dim], results }] };
  if (topValue != null) total_value.value = topValue;
  return { name, period, title: name, id: `mock_${name}/${dim}`, total_value };
}
const res = (seg, value) => ({ dimension_values: [seg], value: Math.round(value) });

function igMockBreakdowns(timeframe = 'last_30_days') {
  // Demographic sums fall ~10% short of followers (privacy cap → coverage gap).
  const covered = Math.round(FOLLOWERS * 0.9);
  const pct = (p) => (covered * p) / 100;

  const age = bd('follower_demographics', 'age', [
    res('13-17', pct(4)),
    res('18-24', pct(26)),
    res('25-34', pct(39)),
    res('35-44', pct(18)),
    res('45-54', pct(8)),
    res('55-64', pct(3)),
    res('65+', pct(2)),
  ]);
  const gender = bd('follower_demographics', 'gender', [
    res('F', pct(57)),
    res('M', pct(42)),
    res('U', pct(1)),
  ]);
  const country = bd('follower_demographics', 'country', [
    res('US', pct(31)),
    res('GB', pct(13)),
    res('DE', pct(9)),
    res('BR', pct(8)),
    res('RU', pct(7)),
    res('UA', pct(6)),
    res('PL', pct(5)),
    res('ES', pct(4)),
    res('FR', pct(4)),
    res('IN', pct(3)),
    res('CA', pct(3)),
    res('IT', pct(2)),
  ]);
  const city = bd('follower_demographics', 'city', [
    res('Москва, Москва', pct(9)),
    res('Санкт-Петербург, Санкт-Петербург', pct(6)),
    res('Киев, Киев', pct(5)),
    res('London, England', pct(5)),
    res('New York, New York', pct(4)),
    res('Berlin, Berlin', pct(3)),
    res('Warsaw, Mazovia', pct(3)),
    res('Madrid, Madrid', pct(3)),
    res('São Paulo, São Paulo', pct(3)),
    res('Toronto, Ontario', pct(2)),
    res('Paris, Île-de-France', pct(2)),
    res('Milan, Lombardy', pct(2)),
  ]);

  // Daily-ish engagement by format (stable per day).
  const day = dayIndex(Date.now());
  const jit = (base) => Math.round(base * (0.9 + seeded(day + base) * 0.2));
  // media_product_type enum (real Graph): FEED / REELS / STORY (carousels count as FEED).
  const interactions = bd(
    'total_interactions',
    'media_product_type',
    [
      res('FEED', jit(830)),
      res('REELS', jit(560)),
      res('STORY', jit(120)),
    ],
    'day',
    jit(830) + jit(560) + jit(120),
  );
  const taps = bd(
    'profile_links_taps',
    'contact_button_type',
    [
      res('WEBSITE', jit(150)),
      res('EMAIL', jit(34)),
      res('CALL', jit(18)),
      res('DIRECTION', jit(12)),
      res('TEXT', jit(6)),
    ],
    'day',
    jit(150) + jit(34) + jit(18) + jit(12) + jit(6),
  );

  return { mock: true, timeframe, data: [age, gender, country, city, interactions, taps] };
}

// online_followers — hourly map per day (evening-skewed). Flaky in reality, so the route
// can return { data: [] } to exercise the heatmap's graceful-degrade path.
function igMockOnlineFollowers(opts = {}) {
  if (opts.empty) return { mock: true, data: [] };
  const today = dayIndex(Date.now());
  const values = [];
  for (let i = 29; i >= 0; i--) {
    const idx = today - i;
    const weekday = new Date(idx * DAY_MS).getUTCDay();
    const weekendBoost = weekday === 0 || weekday === 6 ? 1.15 : 1;
    const map = {};
    for (let h = 0; h < 24; h++) {
      // Evening bell peaking ~19:00 + a small midday bump.
      const evening = Math.exp(-Math.pow(h - 19.5, 2) / 12);
      const midday = 0.35 * Math.exp(-Math.pow(h - 13, 2) / 8);
      const noise = 0.85 + seeded(idx * 31 + h) * 0.3;
      map[String(h)] = Math.round((evening + midday) * 950 * weekendBoost * noise);
    }
    values.push({ value: map, end_time: new Date(idx * DAY_MS + 7 * 3600000).toISOString() });
  }
  return {
    mock: true,
    data: [{ name: 'online_followers', period: 'lifetime', title: 'Online followers', id: 'mock_online', values }],
  };
}

// Active stories (last 24h) + per-story insights & navigation breakdown.
function igMockStories() {
  const now = Date.now();
  const count = 5;
  const data = [];
  for (let i = 0; i < count; i++) {
    const s1 = seeded(i * 17 + 3);
    const s2 = seeded(i * 23 + 9);
    const ageH = 2 + i * 4; // posted 2,6,10,14,18h ago
    const ts = now - ageH * 3600000;
    const reach = Math.round(3500 + s1 * 3500);
    const views = Math.round(reach * (1.05 + s2 * 0.25));
    const tap_back = Math.round(views * (0.03 + s1 * 0.04));
    const tap_exit = Math.round(views * (0.08 + s2 * 0.1));
    const swipe_forward = Math.round(views * (0.05 + s1 * 0.06));
    const tap_forward = Math.max(0, views - tap_back - tap_exit - swipe_forward);
    data.push({
      id: `mock_story_${i}`,
      media_type: i % 2 === 0 ? 'IMAGE' : 'VIDEO',
      timestamp: new Date(ts).toISOString(),
      expires_at: new Date(ts + DAY_MS).toISOString(),
      permalink: `https://instagram.com/stories/pulse.demo/${i}/`,
      thumbnail_url: '',
      reach,
      views,
      replies: Math.round(views * (0.002 + s2 * 0.004)),
      shares: Math.round(views * (0.004 + s1 * 0.006)),
      follows: Math.round(views * (0.002 + s2 * 0.003)),
      profile_visits: Math.round(views * (0.01 + s1 * 0.02)),
      total_interactions: 0, // filled below
      navigation_total: tap_forward + tap_back + tap_exit + swipe_forward,
      navigation: { tap_forward, tap_back, tap_exit, swipe_forward },
    });
    const s = data[data.length - 1];
    s.total_interactions = s.replies + s.shares;
  }
  return { mock: true, data };
}

// Tags — media where the account is @-tagged on someone else's post (the brand-mentions surface).
function igMockTags() {
  const now = Date.now();
  const samples = [
    { user: 'coffee.lab', cap: 'Зажгли любимую свечу @bynotem за завтраком ✨ #notem', type: 'IMAGE', likes: 142, comments: 8, ageH: 5 },
    { user: 'home.and.calm', cap: 'Идеальный вечер: плед, чай и аромат @bynotem 🕯', type: 'CAROUSEL_ALBUM', likes: 318, comments: 21, ageH: 28 },
    { user: 'marie.styles', cap: 'Распаковка нового объекта @bynotem — обзор в сторис', type: 'VIDEO', likes: 96, comments: 4, ageH: 51 },
    { user: 'slowliving.ru', cap: 'Ритуалы повседневности с @bynotem 🤍', type: 'IMAGE', likes: 205, comments: 12, ageH: 96 },
  ];
  return {
    mock: true,
    data: samples.map((s, i) => ({
      id: `mock_tag_${i}`,
      username: s.user,
      caption: s.cap,
      permalink: `https://instagram.com/p/MOCKTAG${i}/`,
      media_type: s.type,
      like_count: s.likes,
      comments_count: s.comments,
      timestamp: new Date(now - s.ageH * 3600000).toISOString(),
    })),
  };
}

module.exports = {
  igMockProfile,
  igMockInsights,
  igMockPosts,
  igMockBreakdowns,
  igMockOnlineFollowers,
  igMockStories,
  igMockTags,
};
