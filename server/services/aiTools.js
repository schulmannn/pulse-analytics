'use strict';

/* ── Read-only инструменты AI-ассистента ──────────────────────────────────────────────────────────
   Каждый вызов проходит канонический ownership-гейт: каналы — db.getChannel(id, user) + ForActor-
   ридеры analyticsRepo, кампании — uid-scoped campaignsRepo. Чужой/несуществующий id неотличим от
   «нет данных» — модель не может прочитать чужой workspace, что бы ни попросил пользователь.

   Контракт run(name, input, user): всегда resolve'ится объектом; { error: '…' } означает
   is_error tool_result (модель видит текст и продолжает). Ответы КОМПАКТНЫЕ: длинные дневные ряды
   сворачиваются в недельные бакеты — контекст модели не резиновый и оплачивается токенами.

   Инварианты продукта зашиты в данные и подписи:
     • TG-просмотры и IG-охват — РАЗНЫЕ метрики, инструменты не смешивают их в одно число;
     • TG «просмотры канала» = сумма дневного потока channel_daily.views (включая старые посты);
     • IG followers = валовые новые подписки (gross), нетто = follows − unfollows;
     • деньги МойСклада (выручка/заказы/средний чек) — своя система величин, с просмотрами
       и охватами не смешиваются.

   Складские инструменты: сводка/клиенты/воронка читают НАШ архив (ms_daily / ms_orders,
   ForActor-ридеры); топ товаров и имена статусов — живые вызовы МойСклада через инъектированный
   sklad = { msFetch, msCrypto } (токен расшифровывается на время вызова и никуда не пишется;
   без подключённого аккаунта инструмент честно отвечает ошибкой). */

const MAX_DAYS = 365;
const DAILY_ROWS_CAP = 35; // до ~5 недель отдаём дни как есть, дальше — недельные бакеты
const MS_TOP_FETCH_LIMIT = 1000; // одна страница отчёта прибыльности (максимум API МС)

function createAiTools({ db, sklad }) {
  const definitions = [
    {
      name: 'get_telegram_metrics',
      description:
        'Дневная динамика Telegram-канала за период: просмотры (дневной поток по всему каналу, включая старые посты), ' +
        'подписчики, подписки/отписки, пересылки, реакции. Используй для вопросов о росте, охвате и динамике TG-канала.',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'integer', description: 'id источника из списка в системном промпте' },
          days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: 'окно в днях, по умолчанию 30' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'get_telegram_top_posts',
      description:
        'Топ публикаций Telegram-канала за период по просмотрам, ER (вовлечённость), пересылкам или реакциям. ' +
        'ER% = (реакции+пересылки+ответы)/просмотры×100.',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'integer', description: 'id источника' },
          days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: 'окно в днях, по умолчанию 30' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: 'сколько постов, по умолчанию 5' },
          sort_by: { type: 'string', enum: ['views', 'er', 'forwards', 'reactions'], description: 'критерий, по умолчанию views' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'get_instagram_metrics',
      description:
        'Дневная динамика Instagram-аккаунта за период: охват, подписчики (валовые новые и нетто), просмотры, ' +
        'взаимодействия (лайки/комментарии/сохранения/репосты). НЕ сравнивай напрямую с просмотрами Telegram.',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'integer', description: 'id источника с Instagram (standalone или связанный)' },
          days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: 'окно в днях, по умолчанию 30' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'get_mentions_summary',
      description:
        'Сводка упоминаний Telegram-канала из сохранённого архива за окно: сколько упоминаний, сколько уникальных ' +
        'каналов, потенциальные просмотры (сумма просмотров упомянувших постов, БЕЗ дедупликации аудитории — это не охват).',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'integer', description: 'id источника' },
          days: { type: 'integer', enum: [7, 30, 90], description: 'окно, по умолчанию 30' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'get_campaigns',
      description: 'Список кампаний (групп контента) пользователя: название, статус, число публикаций, даты.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'get_sklad_metrics',
      description:
        'Продажи МойСклада за период (дневной архив): выручка, число и сумма заказов, средний чек. ' +
        'Используй для вопросов о деньгах, продажах и динамике магазина. channel_id — источник с пометкой «МойСклад».',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'integer', description: 'id источника «МойСклад»' },
          days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: 'окно в днях, по умолчанию 30' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'get_sklad_customers',
      description:
        'Покупатели МойСклада за период: сколько всего, новые vs повторные (новый = первый заказ клиента за всю ' +
        'историю), заказы и выручка по каждой группе, сколько клиентов вообще покупали повторно.',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'integer', description: 'id источника «МойСклад»' },
          days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: 'окно в днях, по умолчанию 30' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'get_sklad_funnel',
      description:
        'Воронка статусов заказов МойСклада за период: сколько заказов и на какую сумму в каждом статусе ' +
        '(новый, в работе, отгружен, возврат и т.п. — по справочнику организации).',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'integer', description: 'id источника «МойСклад»' },
          days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: 'окно в днях, по умолчанию 30' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'get_sklad_top_products',
      description:
        'Топ товаров МойСклада по выручке за период: количество, выручка, прибыль по каждому товару.',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'integer', description: 'id источника «МойСклад»' },
          days: { type: 'integer', minimum: 1, maximum: 90, description: 'окно в днях, по умолчанию 30' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'сколько товаров, по умолчанию 5' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'get_campaign_summary',
      description:
        'Сводка кампании по id: публикации и метрики раздельно по Telegram (просмотры/реакции/пересылки/ответы) ' +
        'и Instagram (охват/просмотры/лайки/комментарии/сохранения/репосты), лучший/худший пост, сравнение с прошлым окном.',
      input_schema: {
        type: 'object',
        properties: { campaign_id: { type: 'integer', description: 'id кампании из get_campaigns' } },
        required: ['campaign_id'],
      },
    },
  ];

  async function run(name, input, user) {
    const args = input && typeof input === 'object' ? input : {};
    switch (name) {
      case 'get_telegram_metrics': return telegramMetrics(args, user);
      case 'get_telegram_top_posts': return telegramTopPosts(args, user);
      case 'get_instagram_metrics': return instagramMetrics(args, user);
      case 'get_mentions_summary': return mentionsSummary(args, user);
      case 'get_campaigns': return campaigns(user);
      case 'get_campaign_summary': return campaignSummary(args, user);
      case 'get_sklad_metrics': return skladMetrics(args, user);
      case 'get_sklad_customers': return skladCustomers(args, user);
      case 'get_sklad_funnel': return skladFunnel(args, user);
      case 'get_sklad_top_products': return skladTopProducts(args, user);
      default: return { error: `Неизвестный инструмент: ${name}` };
    }
  }

  // ── Общие проверки ──────────────────────────────────────────────────────────────────────────
  async function accessibleChannel(args, user) {
    const id = toInt(args.channel_id);
    if (!id || id <= 0) return { error: 'channel_id обязателен (целое число из списка источников).' };
    const ch = await db.getChannel(id, user);
    if (!ch) return { error: 'Источник не найден или недоступен этому пользователю.' };
    return { channel: ch };
  }

  const clampDays = (v, def = 30) => Math.min(MAX_DAYS, Math.max(1, toInt(v) || def));

  // ── Telegram: дневная динамика ──────────────────────────────────────────────────────────────
  async function telegramMetrics(args, user) {
    const gate = await accessibleChannel(args, user);
    if (gate.error) return gate;
    const days = clampDays(args.days);
    const rows = await db.getChannelHistoryForActor(gate.channel.id, user, days);
    if (!rows.length) {
      return { channel: channelRef(gate.channel), period_days: days, note: 'Данных за период нет.' };
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    const out = {
      channel: channelRef(gate.channel),
      period_days: days,
      days_with_data: rows.length,
      totals: {
        views: sumBy(rows, 'views'),
        joins: sumBy(rows, 'joins'),
        leaves: sumBy(rows, 'leaves'),
        net_subscribers: sumBy(rows, 'joins') - sumBy(rows, 'leaves'),
        forwards: sumBy(rows, 'forwards'),
        reactions: sumBy(rows, 'reactions'),
      },
      subscribers: { start: first.subscribers ?? null, end: last.subscribers ?? null },
      note: 'views = дневной поток просмотров всего канала (включая ранее опубликованные посты); это НЕ «просмотры публикаций» окна.',
    };
    if (rows.length <= DAILY_ROWS_CAP) {
      out.daily = rows.map((r) => ({
        day: r.day, views: r.views, joins: r.joins, leaves: r.leaves,
        subscribers: r.subscribers, forwards: r.forwards, reactions: r.reactions,
      }));
    } else {
      out.weekly = weeklyBuckets(rows, ['views', 'joins', 'leaves', 'forwards', 'reactions'], 'subscribers');
    }
    return out;
  }

  // ── Telegram: топ постов ────────────────────────────────────────────────────────────────────
  async function telegramTopPosts(args, user) {
    const gate = await accessibleChannel(args, user);
    if (gate.error) return gate;
    const days = clampDays(args.days);
    const limit = Math.min(10, Math.max(1, toInt(args.limit) || 5));
    const sortBy = ['views', 'er', 'forwards', 'reactions'].includes(args.sort_by) ? args.sort_by : 'views';
    const posts = await db.listPostsForActor(gate.channel.id, user, 100);
    const cutoff = Date.now() - days * 86400000;
    const windowed = posts
      .filter((p) => p.date && new Date(p.date).getTime() >= cutoff)
      .map((p) => {
        const views = p.views || 0;
        const engagement = (p.reactions || 0) + (p.forwards || 0) + (p.replies || 0);
        return {
          post_id: String(p.id),
          date: isoDay(p.date),
          views,
          reactions: p.reactions || 0,
          forwards: p.forwards || 0,
          replies: p.replies || 0,
          er_percent: views > 0 ? round2((engagement / views) * 100) : null,
          media_type: p.media_type || null,
          text: (p.text || '').slice(0, 120) || null,
        };
      });
    const key = sortBy === 'er' ? 'er_percent' : sortBy;
    windowed.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
    return {
      channel: channelRef(gate.channel),
      period_days: days,
      sort_by: sortBy,
      posts_in_window: windowed.length,
      note: 'Архив постов ограничен последними 100 публикациями источника.',
      top: windowed.slice(0, limit),
    };
  }

  // ── Instagram: дневная динамика ─────────────────────────────────────────────────────────────
  async function instagramMetrics(args, user) {
    const gate = await accessibleChannel(args, user);
    if (gate.error) return gate;
    const days = clampDays(args.days);
    const rows = await db.listIgDailyForActor(gate.channel.id, user, days);
    if (!rows.length) {
      return {
        channel: channelRef(gate.channel), period_days: days,
        note: 'Instagram-данных за период нет (аккаунт не подключён или ещё не собран).',
      };
    }
    const last = rows[rows.length - 1];
    const first = rows[0];
    const out = {
      channel: channelRef(gate.channel),
      period_days: days,
      days_with_data: rows.length,
      totals: {
        reach_daily_sum: sumBy(rows, 'reach'),
        views: sumBy(rows, 'views'),
        profile_views: sumBy(rows, 'profile_views'),
        likes: sumBy(rows, 'likes'),
        comments: sumBy(rows, 'comments'),
        saves: sumBy(rows, 'saves'),
        shares: sumBy(rows, 'shares'),
        total_interactions: sumBy(rows, 'total_interactions'),
        new_followers_gross: sumBy(rows, 'followers'),
        follows: sumBy(rows, 'follows'),
        unfollows: sumBy(rows, 'unfollows'),
        net_followers: sumBy(rows, 'follows') - sumBy(rows, 'unfollows'),
      },
      followers_total: { start: first.followers_total ?? null, end: last.followers_total ?? null },
      note: 'reach_daily_sum — сумма ДНЕВНЫХ охватов (не уникальный охват периода). IG-охват нельзя складывать или сравнивать один-в-один с просмотрами Telegram.',
    };
    if (rows.length <= DAILY_ROWS_CAP) {
      out.daily = rows.map((r) => ({
        day: r.day, reach: r.reach, views: r.views, likes: r.likes, comments: r.comments,
        saves: r.saves, shares: r.shares, follows: r.follows, unfollows: r.unfollows,
        followers_total: r.followers_total,
      }));
    } else {
      out.weekly = weeklyBuckets(rows, ['reach', 'views', 'likes', 'comments', 'saves', 'shares', 'follows', 'unfollows'], 'followers_total');
    }
    return out;
  }

  // ── Упоминания ──────────────────────────────────────────────────────────────────────────────
  async function mentionsSummary(args, user) {
    const gate = await accessibleChannel(args, user);
    if (gate.error) return gate;
    const days = [7, 30, 90].includes(toInt(args.days)) ? toInt(args.days) : 30;
    const panel = await db.getMentionsArchiveForActor(gate.channel.id, user, { days, limit: 5 });
    if (!panel || !panel.available) {
      return { channel: channelRef(gate.channel), period_days: days, note: 'Архив упоминаний пуст или недоступен.' };
    }
    return {
      channel: channelRef(gate.channel),
      period_days: days,
      total_mentions: panel.total,
      unique_channels: panel.unique_channels,
      potential_views: panel.total_views,
      previous_window: panel.previous
        ? { total_mentions: panel.previous.total, unique_channels: panel.previous.unique_channels, potential_views: panel.previous.total_views }
        : null,
      top_channels: (panel.top_channels || []).slice(0, 5).map((c) => ({
        title: c.title || null, username: c.username || null, mentions: c.count, views: c.views,
      })),
      recent: (panel.recent || []).slice(0, 5).map((r) => ({
        date: r.date, channel: r.username ? `@${r.username}` : r.title || null,
        views: r.views ?? null, snippet: (r.snippet || '').slice(0, 100) || null,
      })),
      note: 'potential_views — сумма просмотров упомянувших постов БЕЗ дедупликации аудитории; это не охват.',
    };
  }

  // ── Кампании ────────────────────────────────────────────────────────────────────────────────
  async function campaigns(user) {
    const rows = await db.listCampaigns(user.uid);
    if (!rows.length) return { campaigns: [], note: 'Кампаний пока нет.' };
    return {
      campaigns: rows.slice(0, 20).map((c) => ({
        id: c.id, name: c.name, status: c.status, posts: c.post_count,
        start_date: c.start_date, end_date: c.end_date,
      })),
    };
  }

  async function campaignSummary(args, user) {
    const id = toInt(args.campaign_id);
    if (!id || id <= 0) return { error: 'campaign_id обязателен (см. get_campaigns).' };
    const s = await db.getCampaignSummary(user.uid, id);
    if (!s) return { error: 'Кампания не найдена или недоступна.' };
    return {
      campaign: { id: s.campaign.id, name: s.campaign.name, status: s.campaign.status },
      period: s.period,
      posts_total: s.posts_total,
      telegram: s.tg && s.tg.posts
        ? {
            posts: s.tg.posts, views: s.tg.views, reactions: s.tg.reactions,
            forwards: s.tg.forwards, replies: s.tg.replies,
            median_views: s.tg.median, avg_views: s.tg.avg, best_post: s.tg.best,
          }
        : null,
      instagram: s.ig && s.ig.posts
        ? {
            posts: s.ig.posts, reach: s.ig.reach, views: s.ig.views, likes: s.ig.likes,
            comments: s.ig.comments, saved: s.ig.saved, shares: s.ig.shares,
            median_reach: s.ig.median, avg_reach: s.ig.avg, best_post: s.ig.best,
          }
        : null,
      comparison: s.comparison && s.comparison.available ? s.comparison : null,
      note: 'Метрики TG и IG считаются раздельно и не суммируются в одно число.',
    };
  }

  // ── МойСклад: сводка продаж из дневного архива ──────────────────────────────────────────────
  async function skladMetrics(args, user) {
    const gate = await accessibleChannel(args, user);
    if (gate.error) return gate;
    const days = clampDays(args.days);
    const since = sinceDayIso(days);
    const rows = (await db.getMsDailyAllForActor(gate.channel.id, user)).filter((r) => r.day >= since);
    if (!rows.length) {
      return {
        channel: channelRef(gate.channel), period_days: days,
        note: 'Складских данных за период нет (МойСклад не подключён к этому источнику или архив ещё копится).',
      };
    }
    const revenue = sumBy(rows, 'revenue_kopecks');
    const ordersCount = sumBy(rows, 'orders_count');
    const ordersSum = sumBy(rows, 'orders_sum_kopecks');
    const out = {
      channel: channelRef(gate.channel),
      period_days: days,
      days_with_data: rows.length,
      totals: {
        revenue_rub: kopToRub(revenue),
        orders_count: ordersCount,
        orders_sum_rub: kopToRub(ordersSum),
        avg_check_rub: ordersCount > 0 ? kopToRub(ordersSum / ordersCount) : null,
      },
      note: 'Деньги МойСклада — отдельная система величин; не смешивай с просмотрами/охватами соцсетей. Средний чек = сумма заказов / число заказов.',
    };
    if (rows.length <= DAILY_ROWS_CAP) {
      out.daily = rows.map((r) => ({
        day: r.day,
        revenue_rub: kopToRub(r.revenue_kopecks),
        orders: r.orders_count,
        orders_sum_rub: kopToRub(r.orders_sum_kopecks),
      }));
    } else {
      out.weekly = weeklyBuckets(
        rows.map((r) => ({ day: r.day, revenue_kopecks: r.revenue_kopecks, orders: r.orders_count, orders_sum_kopecks: r.orders_sum_kopecks })),
        ['revenue_kopecks', 'orders', 'orders_sum_kopecks'],
      ).map((w) => ({
        week_start: w.week_start, days: w.days,
        revenue_rub: kopToRub(w.revenue_kopecks || 0), orders: w.orders || 0,
        orders_sum_rub: kopToRub(w.orders_sum_kopecks || 0),
      }));
    }
    return out;
  }

  // ── МойСклад: новые vs повторные покупатели ─────────────────────────────────────────────────
  async function skladCustomers(args, user) {
    const gate = await accessibleChannel(args, user);
    if (gate.error) return gate;
    const days = clampDays(args.days);
    const data = await db.getMsCustomersForActor(gate.channel.id, user, { sinceDay: sinceDayIso(days) });
    const s = data.summary;
    if (!s.customers && !s.no_agent_orders) {
      return { channel: channelRef(gate.channel), period_days: days, note: 'Заказов с покупателями за период нет.' };
    }
    return {
      channel: channelRef(gate.channel),
      period_days: days,
      customers_total: s.customers,
      new_customers: s.new_customers,
      repeat_customers: s.repeat_customers,
      orders: { by_new: s.orders_new, by_repeat: s.orders_repeat },
      revenue_rub: { by_new: kopToRub(s.sum_new_kopecks), by_repeat: kopToRub(s.sum_repeat_kopecks) },
      repeat_ever_customers: s.repeat_ever,
      orders_without_customer: s.no_agent_orders,
      note: '«Новый» = первый заказ клиента за всю историю; клиент с первым заказом до окна считается повторным. Заказы без привязанного покупателя посчитаны отдельно.',
    };
  }

  // ── МойСклад: воронка статусов (архив + живой словарь имён, мягкая деградация) ──────────────
  async function skladFunnel(args, user) {
    const gate = await accessibleChannel(args, user);
    if (gate.error) return gate;
    const days = clampDays(args.days);
    const rows = await db.getMsFunnelForActor(gate.channel.id, user, { sinceDay: sinceDayIso(days) });
    if (!rows.length) {
      return { channel: channelRef(gate.channel), period_days: days, note: 'Заказов за период нет.' };
    }
    const dict = await skladStatesDict(gate.channel);
    return {
      channel: channelRef(gate.channel),
      period_days: days,
      statuses: rows.map((r) => ({
        status: r.state_id == null ? 'Без статуса' : (dict && dict[String(r.state_id)]) || r.state_id,
        orders: r.orders,
        sum_rub: kopToRub(r.sum_kopecks),
      })),
      ...(dict ? {} : { note: 'Справочник имён статусов недоступен — показаны технические id.' }),
    };
  }

  // ── МойСклад: топ товаров по выручке (живой отчёт прибыльности) ─────────────────────────────
  async function skladTopProducts(args, user) {
    const gate = await accessibleChannel(args, user);
    if (gate.error) return gate;
    const account = await skladAccount(gate.channel);
    if (!account) return { error: 'МойСклад не подключён к этому источнику.' };
    const days = Math.min(90, Math.max(1, toInt(args.days) || 30));
    const limit = Math.min(20, Math.max(1, toInt(args.limit) || 5));
    let report;
    try {
      report = await sklad.msFetch(
        account.token,
        `/report/profit/byproduct?momentFrom=${encodeURIComponent(`${sinceDayIso(days)} 00:00:00`)}` +
          `&momentTo=${encodeURIComponent(`${todayIso()} 23:59:00`)}&limit=${MS_TOP_FETCH_LIMIT}`,
      );
    } catch (e) {
      return { error: `МойСклад недоступен (${(e && e.status) || 'сеть'}). Попробуй позже.` };
    }
    const rows = (report && Array.isArray(report.rows) ? report.rows : [])
      .map((r) => ({
        name: r && r.assortment && typeof r.assortment.name === 'string' ? r.assortment.name : null,
        quantity: Number(r && r.sellQuantity) || 0,
        revenue_rub: kopToRub(Number(r && r.sellSum) || 0),
        profit_rub: kopToRub(Number(r && r.profit) || 0),
      }))
      // МС отдаёт отчёт не по выручке (алфавит ассортимента) — сортируем сами, как /api/ms/top-products.
      .sort((a, b) => b.revenue_rub - a.revenue_rub || b.quantity - a.quantity);
    const metaSize = Number(report && report.meta && report.meta.size);
    return {
      channel: channelRef(gate.channel),
      period_days: days,
      top: rows.slice(0, limit),
      products_in_window: Number.isFinite(metaSize) ? metaSize : rows.length,
      ...(Number.isFinite(metaSize) && metaSize > MS_TOP_FETCH_LIMIT
        ? { note: `Ассортимент окна больше ${MS_TOP_FETCH_LIMIT} позиций — топ посчитан по первой странице отчёта.` }
        : {}),
    };
  }

  // Расшифрованный токен МС для живых вызовов: только при инъектированном sklad и подключённом
  // аккаунте канала. Токен живёт в замыкании вызова и никогда не попадает в результат/лог.
  async function skladAccount(channel) {
    if (!sklad || !sklad.msFetch || !sklad.msCrypto || !sklad.msCrypto.configured()) return null;
    const account = await db.getMsAccount(channel.id).catch(() => null);
    if (!account || !account.access_token_enc) return null;
    try {
      return { token: sklad.msCrypto.decrypt(account.access_token_enc) };
    } catch {
      return null;
    }
  }

  // Словарь статусов заказов (id → имя) живым вызовом; null при недоступности — воронка
  // деградирует до технических id, DB-агрегат не становится заложником живого МС.
  async function skladStatesDict(channel) {
    const account = await skladAccount(channel);
    if (!account) return null;
    try {
      const meta = await sklad.msFetch(account.token, '/entity/customerorder/metadata');
      const dict = {};
      for (const s of (meta && Array.isArray(meta.states) ? meta.states : [])) {
        if (s && s.id != null && typeof s.name === 'string') dict[String(s.id)] = s.name;
      }
      return dict;
    } catch {
      return null;
    }
  }

  return { definitions, run };
}

// ── Хелперы ────────────────────────────────────────────────────────────────────────────────────
const toInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};
// Копейки БД/МС → рубли на границе инструмента (та же семантика, что kopecksToRub в routes).
const kopToRub = (k) => Math.round(Number(k) || 0) / 100;
// 'YYYY-MM-DD' по часам процесса (Railway = UTC) — та же система координат, что у MS-роутов.
const dayIso = (d) => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};
const todayIso = () => dayIso(new Date());
const sinceDayIso = (days) => {
  const now = new Date();
  return dayIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)));
};
const sumBy = (rows, key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
const round2 = (v) => Math.round(v * 100) / 100;
const isoDay = (d) => {
  try { return new Date(d).toISOString().slice(0, 10); } catch { return null; }
};

/** Недельные бакеты (понедельник — ключ недели): суммы по sumKeys + последний снапшот snapshotKey. */
function weeklyBuckets(rows, sumKeys, snapshotKey) {
  const weeks = new Map();
  for (const r of rows) {
    const d = new Date(`${r.day}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    const dow = (d.getUTCDay() + 6) % 7; // 0 = понедельник
    const monday = new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10);
    const w = weeks.get(monday) || { week_start: monday, days: 0 };
    w.days += 1;
    for (const k of sumKeys) w[k] = (w[k] || 0) + (Number(r[k]) || 0);
    if (snapshotKey && r[snapshotKey] != null) w[snapshotKey] = r[snapshotKey];
    weeks.set(monday, w);
  }
  return [...weeks.values()].sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
}

function channelRef(ch) {
  return { id: ch.id, title: ch.title || null, username: ch.username || null };
}

module.exports = { createAiTools };
