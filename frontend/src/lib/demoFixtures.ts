// Bundled sample data for demo mode. Only endpoints WITHOUT a server-side mock are covered here
// (Telegram + channels); Instagram endpoints intentionally fall through to the server, which already
// serves realistic ig_mock payloads for a no-account (demo) request. Shapes match the permissive
// zod schemas in api/schemas.ts. All series are generated deterministically (no Math.random) so the
// demo looks identical on every render and never trips React's strict-mode double-invoke.

import { DEMO_CHANNEL_ID } from '@/lib/demo';

const DAY_MS = 86_400_000;
const now = Date.now();
const iso = (offsetDays: number) => new Date(now - offsetDays * DAY_MS).toISOString();
const day = (offsetDays: number) => iso(offsetDays).slice(0, 10);
// Smooth deterministic wobble around a trend (seeded by index, no RNG).
const wobble = (i: number, amp: number, period = 6) => Math.round(Math.sin((i / period) * Math.PI * 2) * amp);

// ── 90-day subscriber history — a gentle climb ~10 900 → ~12 500 with daily joins/leaves/views ──
function buildHistory() {
  const rows: Array<Record<string, number | string>> = [];
  let subs = 10_900;
  for (let d = 89; d >= 0; d--) {
    const age = 89 - d; // 0 = oldest, 89 = today
    const joins = 46 + Math.round(14 * Math.abs(Math.sin(age / 4))) + wobble(age, 7) + Math.round(age * 0.15);
    const leaves = 22 + Math.abs(wobble(age, 8, 5));
    subs += joins - leaves;
    const views = 3400 + wobble(age, 850, 8) + Math.round(age * 14);
    rows.push({
      day: day(d),
      subscribers: subs,
      joins,
      leaves,
      views,
      forwards: Math.round(views * 0.012),
      reactions: Math.round(views * 0.052),
    });
  }
  return rows;
}
const HISTORY_ROWS = buildHistory();
const CURRENT_SUBS = Number(HISTORY_ROWS[HISTORY_ROWS.length - 1].subscribers);

// ── Recent posts ──
const POST_SEED: Array<{ text: string; media: string; tags?: string[] }> = [
  { text: 'Запустили новую версию дашборда — теперь метрики обновляются в реальном времени 📊', media: 'photo', tags: ['#продукт', '#релиз'] },
  { text: 'Разбор: как мы выросли на 15% за месяц без рекламного бюджета', media: 'text', tags: ['#рост'] },
  { text: 'Видео-гайд по настройке аналитики за 5 минут', media: 'video' },
  { text: 'Топ-5 ошибок при работе с контент-планом. Сохраняйте, чтобы не потерять', media: 'text', tags: ['#контент'] },
  { text: 'Провели опрос среди подписчиков — делимся результатами в карточках', media: 'photo' },
  { text: 'Что почитать на выходных: подборка материалов по SMM-аналитике', media: 'text', tags: ['#подборка'] },
  { text: 'Кейс клиента: +40% охвата за счёт публикаций в лучшее время', media: 'photo', tags: ['#кейс'] },
  { text: 'Отвечаем на частые вопросы про интеграцию с Telegram и Instagram', media: 'text' },
  { text: 'Короткое видео о том, как читать график вовлечённости', media: 'video' },
  { text: 'Анонс вебинара: работа с аудиторией по сегментам', media: 'photo', tags: ['#вебинар'] },
  { text: 'Мини-исследование: когда ваша аудитория онлайн', media: 'text', tags: ['#аналитика'] },
  { text: 'Спасибо за 12 000 подписчиков! Дальше — интереснее 🚀', media: 'photo' },
];
function buildPosts() {
  return POST_SEED.map((p, i) => {
    const views = 5600 - i * 210 + wobble(i, 620);
    const reactions = Math.round(views * (0.05 + (i % 3) * 0.006));
    return {
      id: 2001 + i,
      text: p.text,
      date: iso(i * 2 + 1),
      views,
      reactions,
      forwards: Math.round(views * 0.013),
      replies: Math.round(views * 0.007),
      media_type: p.media,
      pinned: i === 0,
      hashtags: p.tags ?? [],
      reactions_detail: [
        { emoji: '👍', count: Math.round(reactions * 0.44) },
        { emoji: '🔥', count: Math.round(reactions * 0.31) },
        { emoji: '❤️', count: Math.round(reactions * 0.25) },
      ],
    };
  });
}
const POSTS = buildPosts();

const VIEWS_BY_DAY: Record<string, number> = {};
HISTORY_ROWS.slice(-30).forEach((r) => {
  VIEWS_BY_DAY[String(r.day)] = Number(r.views);
});

// ── Fixture payloads (one per endpoint) ──
const CHANNELS = {
  enabled: true,
  channels: [
    // ig_connected: true so the demo keeps showcasing Instagram (its endpoints fall through to the
    // server's ig_mock) — the switcher's IG-gating hides IG only for real unconnected channels.
    { id: DEMO_CHANNEL_ID, username: 'demo_channel', title: 'Демо-канал', status: 'active', source: 'central', memberCount: CURRENT_SUBS, owner_uid: 0, ig_connected: true },
  ],
  selected: DEMO_CHANNEL_ID,
};

const TG_FULL = {
  channel: { title: 'Демо-канал', username: 'demo_channel', description: 'Пример канала с демо-данными', memberCount: CURRENT_SUBS, source: 'central' },
  views_summary: {
    total_views: POSTS.reduce((s, p) => s + p.views, 0),
    total_reactions: POSTS.reduce((s, p) => s + p.reactions, 0),
    total_forwards: POSTS.reduce((s, p) => s + p.forwards, 0),
    total_replies: POSTS.reduce((s, p) => s + p.replies, 0),
    avg_views: Math.round(POSTS.reduce((s, p) => s + p.views, 0) / POSTS.length),
    posts_analyzed: POSTS.length,
    views_by_day: VIEWS_BY_DAY,
    avg_views_by_type: { photo: 4900, video: 5400, text: 4200 },
  },
  posts: POSTS,
  mtproto_available: true,
  source: 'demo',
};

const HISTORY_RESP = { enabled: true, rows: HISTORY_ROWS };

const TG_STATS = {
  views_per_post: { current: TG_FULL.views_summary.avg_views },
  shares_per_post: { current: Math.round(TG_FULL.views_summary.total_forwards / POSTS.length) },
  reactions_per_post: { current: Math.round(TG_FULL.views_summary.total_reactions / POSTS.length) },
  enabled_notifications: { part: Math.round(CURRENT_SUBS * 0.66), total: CURRENT_SUBS },
};

const TG_VELOCITY = {
  available: true,
  by_day: [0, 1, 2, 3, 4, 5, 6].map((d) => {
    const shareByDay = [0.46, 0.24, 0.12, 0.07, 0.05, 0.035, 0.025][d];
    const cum = [0.46, 0.7, 0.82, 0.89, 0.94, 0.975, 1][d];
    return { day: d, cum, share: shareByDay };
  }),
  day1_share: 0.46,
  t80_days: 2,
  posts_used: 40,
  source: 'demo',
};

const growthValues = HISTORY_ROWS.slice(-30).map((r) => Number(r.subscribers));
const viewsValues = HISTORY_ROWS.slice(-30).map((r) => Number(r.views));
const reactValues = HISTORY_ROWS.slice(-30).map((r) => Number(r.reactions));
const xAxis = HISTORY_ROWS.slice(-30).map((r) => Math.floor(new Date(String(r.day)).getTime() / 1000));
const TG_GRAPHS = {
  growth: { x: xAxis, series: [{ name: 'Подписчики', values: growthValues }] },
  followers: { x: xAxis, series: [{ name: 'Подписчики', values: growthValues }] },
  interactions: { x: xAxis, series: [{ name: 'Просмотры', values: viewsValues }, { name: 'Реакции', values: reactValues }] },
  top_hours: { hours: Array.from({ length: 24 }, (_, h) => h), values: Array.from({ length: 24 }, (_, h) => 40 + Math.round(60 * Math.max(0, Math.sin(((h - 6) / 24) * Math.PI * 2)))) },
  views_by_source: [
    { label: 'Подписчики', value: 71 },
    { label: 'Пересылки', value: 16 },
    { label: 'Поиск / ссылки', value: 9 },
    { label: 'Каналы', value: 4 },
  ],
  new_followers_by_source: [
    { label: 'Пересылки', value: 38 },
    { label: 'Поиск', value: 27 },
    { label: 'Ссылки', value: 21 },
    { label: 'Другое', value: 14 },
  ],
  languages: [
    { label: 'Русский', value: 68 },
    { label: 'Английский', value: 19 },
    { label: 'Украинский', value: 8 },
    { label: 'Другое', value: 5 },
  ],
  reactions_sentiment: [
    { label: 'Позитивные', value: 82 },
    { label: 'Нейтральные', value: 13 },
    { label: 'Негативные', value: 5 },
  ],
};

const MENTION_CHANNELS = [
  { username: 'smm_daily', title: 'SMM Daily', count: 9, views: 21400 },
  { username: 'marketing_ru', title: 'Маркетинг на русском', count: 6, views: 15800 },
  { username: 'startup_notes', title: 'Startup Notes', count: 4, views: 9200 },
  { username: 'content_lab', title: 'Content Lab', count: 3, views: 6100 },
];
const MENTIONS = {
  available: true,
  total: MENTION_CHANNELS.reduce((s, c) => s + c.count, 0),
  unique_channels: MENTION_CHANNELS.length,
  total_views: MENTION_CHANNELS.reduce((s, c) => s + c.views, 0),
  by_day: Object.fromEntries(HISTORY_ROWS.slice(-14).map((r, i) => [String(r.day), 1 + (i % 4)])),
  top_channels: MENTION_CHANNELS,
  recent: [
    { date: iso(1), username: 'smm_daily', title: 'SMM Daily', link: 'https://t.me/smm_daily/1200', views: 3400, snippet: 'Отличный разбор аналитики от @demo_channel — рекомендуем.' },
    { date: iso(2), username: 'marketing_ru', title: 'Маркетинг на русском', link: 'https://t.me/marketing_ru/845', views: 2900, snippet: 'Коллеги из @demo_channel показали, как считать ER правильно.' },
    { date: iso(4), username: 'startup_notes', title: 'Startup Notes', link: 'https://t.me/startup_notes/331', views: 2100, snippet: 'Кейс роста без бюджета — ссылка на @demo_channel.' },
  ],
};

function postStats() {
  const x = Array.from({ length: 48 }, (_, i) => now / 1000 - (47 - i) * 3600);
  let cum = 0;
  const values = x.map((_, i) => {
    cum += Math.max(0, Math.round(220 * Math.exp(-i / 12)) + wobble(i, 20));
    return cum;
  });
  return {
    available: true,
    views_graph: { x, series: [{ name: 'Просмотры', values }] },
    reactions: [
      { label: '👍', value: 142 },
      { label: '🔥', value: 98 },
      { label: '❤️', value: 76 },
      { label: '👏', value: 41 },
    ],
  };
}

/**
 * Resolve a request path to its demo fixture, or `undefined` to let the request fall through to the
 * real server (Instagram endpoints, anything not covered). The path may carry a query string.
 */
export function demoFixture(path: string): unknown | undefined {
  const p = path.split('?')[0];
  if (p === '/api/channels') return CHANNELS;
  if (p === '/api/tg/full') return TG_FULL;
  if (p === '/api/history/channel') return HISTORY_RESP;
  if (p === '/api/history/mentions' || p === '/api/tg/mtproto/mentions') return MENTIONS;
  if (p === '/api/tg/mtproto/stats') return TG_STATS;
  if (p === '/api/tg/mtproto/graphs') return TG_GRAPHS;
  if (p === '/api/tg/mtproto/velocity') return TG_VELOCITY;
  if (p.startsWith('/api/tg/mtproto/post_stats/')) return postStats();
  if (p.endsWith('/collector-status')) return { status: null };
  if (p.endsWith('/keys')) return { keys: [] };
  return undefined;
}
