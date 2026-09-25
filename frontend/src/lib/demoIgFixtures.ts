// Instagram-фикстуры демо-режима — клиентский порт server/ig_mock.js (канон форм Graph v22+).
//
// Почему клиентски: публичное демо (лендинг → «Смотреть демо») живёт БЕЗ серверной сессии —
// AuthGate синтезирует DEMO_ME, cookie нет, а все /api/ig/* стоят за requireAuth и отвечают 401.
// Прежний контракт «IG падает на сервер, там ig_mock» работал только для залогиненного демо и
// умер вместе с публичным входом. Поэтому демо-граф обслуживает IG сам — теми же детерминированными
// payload'ами, что сервер отдаёт no-account запросу (значения стабильны в пределах календарного
// дня; без Math.random — переживает StrictMode double-invoke).
//
// Отличия от server/ig_mock.js — осознанные:
// - профиль назван demo_channel (единый бренд демо-воркспейса; CSV-слаг экспорта и
//   source-identity в e2e закреплены за ним);
// - дневная серия insights всегда 90 дней независимо от ?days — зеркалит реальный роут
//   (dailyCall с since=now−90д): окна 7д/30д получают полный предыдущий период для дельт,
//   у 90д предыдущего нет — как и у настоящего аккаунта.

const DAY_MS = 86_400_000;
const seeded = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};
const dayIndex = (ms: number) => Math.floor(ms / DAY_MS);
// Роуты сервера прижимают пользовательский параметр к малому enum до кэш-ключа; фикстура
// повторяет, чтобы демо и no-account прод отдавали одинаковые объёмы.
const nearestOf = (value: number, allowed: number[]) =>
  allowed.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), allowed[0]);

const FOLLOWERS = 12_480;

type Json = Record<string, unknown>;

function igDemoProfile(): Json {
  return {
    mock: true,
    id: 'demo_account',
    username: 'demo_channel',
    name: 'Демо-канал',
    followers_count: FOLLOWERS,
    follows_count: 312,
    media_count: 248,
    biography: 'Демо-аккаунт для предпросмотра аналитики Atlavue',
    website: 'https://atlavue.app',
    profile_picture_url: '',
  };
}

// Дневные метрики аккаунта — { name, period, values:[{ value, end_time }] }, как time_series
// реального Graph. Всегда 90 точек (см. шапку файла).
function igDemoInsights(): Json {
  const d = 90;
  const today = dayIndex(Date.now());

  const buildMetric = (name: string, base: number, spread: number, weekendDamp = true): Json => {
    const values: Json[] = [];
    for (let i = d - 1; i >= 0; i--) {
      const idx = today - i;
      const noise = seeded(idx * 7 + name.length);
      const weekday = new Date(idx * DAY_MS).getUTCDay();
      const damp = weekendDamp && (weekday === 0 || weekday === 6) ? 0.78 : 1;
      const value = Math.max(0, Math.round((base + (noise - 0.5) * spread) * damp));
      values.push({ value, end_time: new Date(idx * DAY_MS + 7 * 3_600_000).toISOString() });
    }
    return { name, period: 'day', title: name, description: 'mock', id: `mock_${name}`, values };
  };

  return {
    mock: true,
    data: [
      buildMetric('reach', 5200, 3400),
      buildMetric('views', 8800, 5200),
      buildMetric('profile_views', 240, 180),
      buildMetric('follower_count', 55, 90), // дневной NET-прирост подписчиков
      buildMetric('accounts_engaged', 900, 600),
      buildMetric('total_interactions', 1300, 800),
      buildMetric('likes', 1050, 650),
      buildMetric('comments', 70, 60),
      buildMetric('saves', 130, 120),
      buildMetric('shares', 90, 90),
      buildMetric('follows', 70, 60), // gross-подписки (FOLLOWER)
      buildMetric('unfollows', 48, 44), // gross-отписки — в демо баланс положительный
    ],
  };
}

const CAPTIONS = [
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

// Публикации + per-media insights одним объектом; Reels несут watch-time в МИЛЛИСЕКУНДАХ.
function igDemoPosts(rawLimit: number): Json {
  const n = nearestOf(Math.min(25, Math.max(1, rawLimit || 20)), [6, 12, 25]);
  const now = Date.now();
  const data: Json[] = [];
  for (let i = 0; i < n; i++) {
    const s1 = seeded(i * 13 + 1);
    const s2 = seeded(i * 29 + 5);
    const type = MEDIA_TYPES[i % MEDIA_TYPES.length];
    const isReel = type === 'REELS';
    const reach = Math.round(3000 + s1 * 14_000);
    const views = Math.round(reach * (1.4 + s2 * 0.7));
    const likes = Math.round(reach * (0.04 + s2 * 0.06));
    const comments = Math.round(likes * (0.02 + s1 * 0.05));
    const saved = Math.round(likes * (0.05 + s2 * 0.2));
    const shares = Math.round(likes * (0.02 + s1 * 0.08));
    const post: Json = {
      id: `mock_${i}`,
      caption: CAPTIONS[i % CAPTIONS.length],
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
      impressions: Math.round(reach * (1.3 + s2 * 0.6)),
      shares,
      saved,
      total_interactions: likes + comments + saved + shares,
    };
    if (isReel) {
      const avgWatchMs = Math.round(4000 + s1 * 9000); // 4–13 с
      post.ig_reels_avg_watch_time = avgWatchMs;
      post.ig_reels_video_view_total_time = avgWatchMs * views;
    }
    data.push(post);
  }
  return { mock: true, data };
}

// ── total_value + breakdowns конверт (демография, форматы, контакты) ──
function bd(name: string, dim: string, results: Json[], period = 'lifetime', topValue?: number): Json {
  const total_value: Json = { breakdowns: [{ dimension_keys: [dim], results }] };
  if (topValue != null) total_value.value = topValue;
  return { name, period, title: name, id: `mock_${name}/${dim}`, total_value };
}
const res = (seg: string, value: number): Json => ({ dimension_values: [seg], value: Math.round(value) });

function igDemoBreakdowns(rawTimeframe: string): Json {
  const allowed = ['last_14_days', 'last_30_days', 'last_90_days'];
  const timeframe = allowed.includes(rawTimeframe) ? rawTimeframe : 'last_30_days';
  // Сумма по демографии ~на 10% меньше подписчиков (privacy-кап покрытия).
  const covered = Math.round(FOLLOWERS * 0.9);
  const pct = (p: number) => (covered * p) / 100;

  const age = bd('follower_demographics', 'age', [
    res('13-17', pct(4)),
    res('18-24', pct(26)),
    res('25-34', pct(39)),
    res('35-44', pct(18)),
    res('45-54', pct(8)),
    res('55-64', pct(3)),
    res('65+', pct(2)),
  ]);
  const gender = bd('follower_demographics', 'gender', [res('F', pct(57)), res('M', pct(42)), res('U', pct(1))]);
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

  // Вовлечённость по форматам и переходы по кнопкам — стабильны в пределах дня.
  const day = dayIndex(Date.now());
  const jit = (base: number) => Math.round(base * (0.9 + seeded(day + base) * 0.2));
  const interactions = bd(
    'total_interactions',
    'media_product_type',
    [res('FEED', jit(830)), res('REELS', jit(560)), res('STORY', jit(120))],
    'day',
    jit(830) + jit(560) + jit(120),
  );
  const taps = bd(
    'profile_links_taps',
    'contact_button_type',
    [res('WEBSITE', jit(150)), res('EMAIL', jit(34)), res('CALL', jit(18)), res('DIRECTION', jit(12)), res('TEXT', jit(6))],
    'day',
    jit(150) + jit(34) + jit(18) + jit(12) + jit(6),
  );

  return { mock: true, timeframe, data: [age, gender, country, city, interactions, taps] };
}

// online_followers — почасовая карта за 30 дней (вечерний пик ~19:00 + полуденный бугор).
function igDemoOnline(): Json {
  const today = dayIndex(Date.now());
  const values: Json[] = [];
  for (let i = 29; i >= 0; i--) {
    const idx = today - i;
    const weekday = new Date(idx * DAY_MS).getUTCDay();
    const weekendBoost = weekday === 0 || weekday === 6 ? 1.15 : 1;
    const map: Record<string, number> = {};
    for (let h = 0; h < 24; h++) {
      const evening = Math.exp(-((h - 19.5) ** 2) / 12);
      const midday = 0.35 * Math.exp(-((h - 13) ** 2) / 8);
      const noise = 0.85 + seeded(idx * 31 + h) * 0.3;
      map[String(h)] = Math.round((evening + midday) * 950 * weekendBoost * noise);
    }
    values.push({ value: map, end_time: new Date(idx * DAY_MS + 7 * 3_600_000).toISOString() });
  }
  return {
    mock: true,
    data: [{ name: 'online_followers', period: 'lifetime', title: 'Online followers', id: 'mock_online', values }],
  };
}

// Активные сторис (последние 24 ч) + инсайты и navigation-разбивка.
function igDemoStories(): Json {
  const now = Date.now();
  const data: Json[] = [];
  for (let i = 0; i < 5; i++) {
    const s1 = seeded(i * 17 + 3);
    const s2 = seeded(i * 23 + 9);
    const ts = now - (2 + i * 4) * 3_600_000;
    const reach = Math.round(3500 + s1 * 3500);
    const views = Math.round(reach * (1.05 + s2 * 0.25));
    const tap_back = Math.round(views * (0.03 + s1 * 0.04));
    const tap_exit = Math.round(views * (0.08 + s2 * 0.1));
    const swipe_forward = Math.round(views * (0.05 + s1 * 0.06));
    const tap_forward = Math.max(0, views - tap_back - tap_exit - swipe_forward);
    const replies = Math.round(views * (0.002 + s2 * 0.004));
    const shares = Math.round(views * (0.004 + s1 * 0.006));
    data.push({
      id: `mock_story_${i}`,
      media_type: i % 2 === 0 ? 'IMAGE' : 'VIDEO',
      timestamp: new Date(ts).toISOString(),
      expires_at: new Date(ts + DAY_MS).toISOString(),
      permalink: `https://instagram.com/stories/demo_channel/${i}/`,
      thumbnail_url: '',
      reach,
      views,
      replies,
      shares,
      follows: Math.round(views * (0.002 + s2 * 0.003)),
      profile_visits: Math.round(views * (0.01 + s1 * 0.02)),
      total_interactions: replies + shares,
      navigation_total: tap_forward + tap_back + tap_exit + swipe_forward,
      navigation: { tap_forward, tap_back, tap_exit, swipe_forward },
    });
  }
  return { mock: true, data };
}

// Отметки — посты, где демо-аккаунт @-упомянут в чужих публикациях.
function igDemoTags(): Json {
  const now = Date.now();
  const samples = [
    { user: 'smm.daily', cap: 'Разбор аналитики от @demo_channel — сохраняйте в закладки ✨', type: 'IMAGE', likes: 142, comments: 8, ageH: 5 },
    { user: 'marketing.club', cap: 'Как @demo_channel считает охваты без самообмана — карусель', type: 'CAROUSEL_ALBUM', likes: 318, comments: 21, ageH: 28 },
    { user: 'content.makers', cap: 'Сняли закулисье вместе с @demo_channel — обзор в сторис', type: 'VIDEO', likes: 96, comments: 4, ageH: 51 },
    { user: 'growth.notes', cap: 'Кейс роста аудитории с @demo_channel 🤍', type: 'IMAGE', likes: 205, comments: 12, ageH: 96 },
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
      timestamp: new Date(now - s.ageH * 3_600_000).toISOString(),
    })),
  };
}

/**
 * IG-неймспейс демо-фикстур: путь (с query) → payload, `undefined` = не покрыто (уйдёт на сервер,
 * где неавторизованное демо получит 401 — поэтому всё, что демо-граф реально запрашивает, обязано
 * быть перечислено здесь; регресс держат demoFixtures.test.ts и e2e demo-instagram.spec.ts).
 */
export function igDemoFixture(path: string): unknown | undefined {
  const [p, qs = ''] = path.split('?');
  const params = new URLSearchParams(qs);
  if (p === '/api/ig/profile') return igDemoProfile();
  if (p === '/api/ig/insights') return igDemoInsights();
  if (p === '/api/ig/posts') return igDemoPosts(parseInt(params.get('limit') ?? '', 10) || 20);
  if (p === '/api/ig/breakdowns') return igDemoBreakdowns(params.get('timeframe') ?? '');
  if (p === '/api/ig/online') return igDemoOnline();
  if (p === '/api/ig/stories') return igDemoStories();
  if (p === '/api/ig/tags') return igDemoTags();
  // Постоянной ig_daily-истории у демо нет — клиент прозрачно живёт живой серией (тот же контракт,
  // что у env/mock-фолбэка реального роута: rows пустые).
  if (p === '/api/ig/history') return { enabled: false, rows: [] };
  // Статус подключения: прод-правда для канала без IG-строки. server_ready:true оставляет кнопку
  // «Подключить» активной; сам клик упрётся в штатную блокировку записей демо-режима (apiSend).
  if (p === '/api/ig/oauth/status') {
    return {
      server_ready: true,
      env_fallback: false,
      connected: false,
      channel_id: null,
      username: null,
      ig_user_id: null,
      connected_at: null,
      token_expires_at: null,
    };
  }
  return undefined;
}
