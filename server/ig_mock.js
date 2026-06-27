'use strict';
// ════════════════════════════════════════════════════════════════
//  INSTAGRAM — deterministic MOCK payloads (Graph API shapes)
// ════════════════════════════════════════════════════════════════
// Lets us build the IG analytics UI before a real account is connected. The /api/ig/*
// routes fall back to these whenever IG_ACCESS_TOKEN / IG_ACCOUNT_ID are unset, so the
// frontend consumes the exact same response shape it will get from the real Graph API —
// nothing in the client changes once real credentials are added. Values are stable per
// calendar day (seeded), so charts don't jitter on every refresh.

// Cheap deterministic pseudo-random in [0,1) from an integer seed.
const seeded = (n) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};
const DAY_MS = 86400000;
const dayIndex = (ms) => Math.floor(ms / DAY_MS);

function igMockProfile() {
  return {
    mock: true,
    id: 'mock_account',
    username: 'pulse.demo',
    name: 'Pulse Demo',
    followers_count: 12480,
    follows_count: 312,
    media_count: 248,
    biography: 'Демо-аккаунт для предпросмотра аналитики Pulse',
    website: 'https://atlavue.com',
    profile_picture_url: '',
  };
}

// Account insights, mirroring GET /{ig-user}/insights?period=day. Each metric is a
// { name, period, values:[{ value, end_time }] } block — exactly the Graph API layout.
function igMockInsights(days = 30) {
  const d = Math.min(90, Math.max(1, Number(days) || 30));
  const today = dayIndex(Date.now());

  const buildMetric = (name, base, spread, weekendDamp = true) => {
    const values = [];
    for (let i = d - 1; i >= 0; i--) {
      const idx = today - i;
      const noise = seeded(idx * 7 + name.length);
      const weekday = new Date(idx * DAY_MS).getUTCDay(); // 0 Sun .. 6 Sat
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
      buildMetric('impressions', 8800, 5200),
      buildMetric('profile_views', 240, 180),
      buildMetric('follower_count', 55, 90), // daily NET-NEW followers (Graph API semantics)
      buildMetric('website_clicks', 18, 26),
    ],
  };
}

const MOCK_CAPTIONS = [
  'Как мы выросли на 40% за квартал — разбор по шагам 📈',
  'Новый дроп уже в профиле. Листай карусель 👉',
  'Reels недели: за кадром нашей съёмки 🎬',
  'Топ-5 ошибок в контент-плане (сохрани, чтобы не забыть)',
  'Отвечаем на ваши вопросы в комментах 💬',
  'Гайд: как мы собираем аналитику по всем соцсетям',
  'Анонс коллаборации — детали скоро ✨',
  'Подводим итоги месяца цифрами',
  'Закулисье: один день из жизни команды',
  'Мини-кейс: +2.3k охвата с одного поста',
  'Полезная подборка инструментов для SMM',
  'Спасибо за 12k! Дальше — больше 🚀',
];
const MEDIA_TYPES = ['IMAGE', 'CAROUSEL_ALBUM', 'REELS', 'VIDEO'];

// Recent media, mirroring GET /{ig-user}/media + per-media insights merged in.
function igMockPosts(limit = 20) {
  const n = Math.min(25, Math.max(1, Number(limit) || 20));
  const now = Date.now();
  const data = [];
  for (let i = 0; i < n; i++) {
    const s1 = seeded(i * 13 + 1);
    const s2 = seeded(i * 29 + 5);
    const type = MEDIA_TYPES[i % MEDIA_TYPES.length];
    const reach = Math.round(3000 + s1 * 14000);
    const impressions = Math.round(reach * (1.3 + s2 * 0.6));
    const likes = Math.round(reach * (0.04 + s2 * 0.06));
    const comments = Math.round(likes * (0.02 + s1 * 0.05));
    const saved = Math.round(likes * (0.05 + s2 * 0.2));
    const shares = Math.round(likes * (0.02 + s1 * 0.08));
    data.push({
      id: `mock_${i}`,
      caption: MOCK_CAPTIONS[i % MOCK_CAPTIONS.length],
      media_type: type,
      media_url: '',
      thumbnail_url: '',
      permalink: `https://instagram.com/p/MOCK${i}/`,
      timestamp: new Date(now - Math.round(i * 3.2 * DAY_MS)).toISOString(),
      like_count: likes,
      comments_count: comments,
      reach,
      impressions,
      shares,
      saved,
    });
  }
  return { mock: true, data };
}

module.exports = { igMockProfile, igMockInsights, igMockPosts };
