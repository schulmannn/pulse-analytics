'use strict';

// Focused unit tests for the IG collection JOB throttle-propagation + bounded fan-out. No network:
// igFetch is a programmable fake routed by (path, params). Asserts: a throttle (HTTP 429 / synthetic
// gate flag) in an ordinary catch AND inside a bounded allSettled fan-out both RETHROW out of
// collectIgForAccount (so runJobOnce marks the day failed/retryable); a permanent unsupported-metric
// error stays best-effort (day still upserts); story insight calls stay <= 2 in flight with all
// stories preserved; and daily/demographic bounded fan-out preserves input order.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstagramCollectionJob, isIgThrottleError } = require('../server/jobs/instagramCollectionJob');

const ACC = { channel_id: 1, ig_user_id: 'IG1', access_token_enc: 'enc', token_expires_at: null };
const DAY = '2026-07-16';

function throttle(status = 429) { const e = new Error('rate limited'); e.status = status; return e; }
function permanent() { const e = new Error('unsupported metric'); e.status = 502; e.graph = { code: 100 }; return e; }

// handlers(path, params) → response | throws. saved captures DB writes; inflight tracks concurrency.
function makeJob(handlers) {
  const saved = { daily: null, media: null, snapshots: [] };
  const inflight = { cur: 0, max: 0, storyCur: 0, storyMax: 0 };
  const igFetch = async (path, params = {}) => {
    const isStory = /^\/S\d+\/insights$/.test(path);
    inflight.cur++; if (inflight.cur > inflight.max) inflight.max = inflight.cur;
    if (isStory) { inflight.storyCur++; if (inflight.storyCur > inflight.storyMax) inflight.storyMax = inflight.storyCur; }
    try {
      await new Promise((r) => setImmediate(r));   // уступаем event loop → видна реальная конкуренция
      return handlers(path, params);
    } finally {
      inflight.cur--; if (isStory) inflight.storyCur--;
    }
  };
  const db = {
    upsertIgDaily: async (_chan, rows) => { saved.daily = rows; },
    upsertIgMediaDaily: async (_chan, rows) => { saved.media = rows; },
    saveRawSnapshot: async (_chan, _net, kind, _day, payload) => { saved.snapshots.push({ kind, payload }); },
  };
  const job = createInstagramCollectionJob({
    db, log: () => {}, igCrypto: { decrypt: () => 'TOKEN' },
    igFetch, refreshIgIfNeeded: async (_c, t) => t,
  });
  return { job, saved, inflight };
}

// Benign default responses so unrelated sections never throttle.
function benign(path, params) {
  if (path === '/IG1/insights' && params.metric === 'reach,follower_count') {
    return { data: [{ name: 'reach', values: [{ value: 5 }] }, { name: 'follower_count', values: [{ value: 9 }] }] };
  }
  if (params.metric === 'follows_and_unfollows') {
    return { data: [{ total_value: { breakdowns: [{ results: [
      { dimension_values: ['FOLLOWER'], value: 3 }, { dimension_values: ['NON_FOLLOWER'], value: 1 }] }] } }] };
  }
  if (path === '/IG1' && params.fields === 'followers_count') return { followers_count: 100 };
  if (path === '/IG1/media') return { data: [] };
  if (path === '/IG1/stories') return { data: [] };
  return { data: [] };   // TV metrics, demographics, online → empty ok
}

test('throttle в обычном catch (дневная серия) пробрасывается из collectIgForAccount', async () => {
  const { job } = makeJob((path, params) => {
    if (path === '/IG1/insights' && params.metric === 'reach,follower_count') throw throttle(429);
    return benign(path, params);
  });
  await assert.rejects(job.collectIgForAccount(ACC, DAY), (e) => isIgThrottleError(e) && e.status === 429);
});

test('throttle внутри bounded allSettled (total_value-метрика) пробрасывается', async () => {
  const { job, saved } = makeJob((path, params) => {
    if (path === '/IG1/insights' && params.metric === 'shares' && params.metric_type === 'total_value') throw throttle(429);
    return benign(path, params);
  });
  await assert.rejects(job.collectIgForAccount(ACC, DAY), (e) => isIgThrottleError(e));
  assert.equal(saved.daily, null, 'день НЕ сохранён — throttle прервал сбор до upsert');
});

test('синтетический флаг gate тоже считается throttle и пробрасывается', async () => {
  const { job } = makeJob((path, params) => {
    if (path === '/IG1/media') { const e = new Error('paused'); e.igGateStopped = true; e.status = 429; throw e; }
    return benign(path, params);
  });
  await assert.rejects(job.collectIgForAccount(ACC, DAY), (e) => e.igGateStopped === true);
});

test('перманентная unsupported-метрика остаётся best-effort: день всё равно сохраняется', async () => {
  const values = { views: 11, profile_views: 22, accounts_engaged: 33, total_interactions: 44, likes: 55, comments: 66, saves: 77 };
  const { job, saved } = makeJob((path, params) => {
    if (path === '/IG1/insights' && params.metric_type === 'total_value' && params.metric in values) {
      return { data: [{ total_value: { value: values[params.metric] } }] };
    }
    if (path === '/IG1/insights' && params.metric === 'shares' && params.metric_type === 'total_value') throw permanent();
    return benign(path, params);
  });
  await job.collectIgForAccount(ACC, DAY);   // не должно бросать
  assert.ok(saved.daily, 'день сохранён несмотря на одну неподдерживаемую метрику');
  const row = saved.daily[0];
  assert.equal(row.views, 11);
  assert.equal(row.likes, 55);
  assert.equal(row.shares, undefined, 'упавшая метрика просто отсутствует (best-effort)');
});

test('bounded total_value фан-аут сохраняет порядок → корректная привязка метрик', async () => {
  const values = { views: 1, profile_views: 2, accounts_engaged: 3, total_interactions: 4, likes: 5, comments: 6, saves: 7, shares: 8 };
  const { job, saved } = makeJob((path, params) => {
    if (path === '/IG1/insights' && params.metric_type === 'total_value' && params.metric in values && params.breakdown == null) {
      return { data: [{ total_value: { value: values[params.metric] } }] };
    }
    return benign(path, params);
  });
  await job.collectIgForAccount(ACC, DAY);
  const row = saved.daily[0];
  for (const [metric, v] of Object.entries(values)) assert.equal(row[metric], v, `${metric} привязан к своему значению`);
});

test('demographics bounded фан-аут (concurrency=2) сохраняет порядок вызовов в payload', async () => {
  // Каждый demographics-вызов метит свои data порядковым маркером; после flatMap порядок обязан
  // совпасть с порядком calls (6 вызовов: age/gender/country/city/total_interactions/profile_links_taps).
  const order = ['age', 'gender', 'country', 'city', undefined, undefined];
  let contactSeen = 0;
  const { job, saved, inflight } = makeJob((path, params) => {
    if (path === '/IG1/insights' && params.metric === 'follower_demographics') {
      const idx = order.indexOf(params.breakdown);
      return { data: [{ marker: idx }] };
    }
    if (path === '/IG1/insights' && params.metric === 'total_interactions' && params.breakdown === 'media_product_type') return { data: [{ marker: 4 }] };
    if (path === '/IG1/insights' && params.metric === 'profile_links_taps') { contactSeen++; return { data: [{ marker: 5 }] }; }
    return benign(path, params);
  });
  await job.collectIgForAccount(ACC, DAY);
  const demo = saved.snapshots.find((s) => s.kind === 'demographics');
  assert.ok(demo, 'demographics снимок сохранён');
  assert.deepEqual(demo.payload.data.map((d) => d.marker), [0, 1, 2, 3, 4, 5], 'порядок вызовов сохранён');
  assert.equal(contactSeen, 1);
  assert.ok(inflight.max <= 2, `bounded=2: не более 2 вызовов в полёте, было ${inflight.max}`);
});

test('stories: не более 2 story-insight вызовов в полёте, все сторис и best-effort метрики сохранены', async () => {
  const storyIds = ['S1', 'S2', 'S3', 'S4', 'S5'];
  const { job, saved, inflight } = makeJob((path, params) => {
    if (path === '/IG1/stories') return { data: storyIds.map((id) => ({ id, media_type: 'IMAGE', timestamp: '2026-07-16T00:00:00Z' })) };
    if (/^\/S\d+\/insights$/.test(path)) {
      if (params.metric === 'replies') { const e = new Error('unsupported'); e.status = 502; throw e; }   // перманентная per-метрик
      return { data: [{ total_value: { value: 7 } }] };
    }
    return benign(path, params);
  });
  await job.collectIgForAccount(ACC, DAY);
  assert.ok(inflight.storyMax <= 2, `не более 2 story-insight в полёте, было ${inflight.storyMax}`);
  const stories = saved.snapshots.find((s) => s.kind === 'stories');
  assert.ok(stories, 'сторис-снимок сохранён');
  assert.equal(stories.payload.data.length, 5, 'все 5 сторис сохранены');
  assert.deepEqual(stories.payload.data.map((s) => s.id), storyIds, 'порядок сторис сохранён');
  assert.equal(stories.payload.data[0].reach, 7, 'поддерживаемая метрика заполнена');
  assert.equal(stories.payload.data[0].replies, undefined, 'упавшая метрика отсутствует (best-effort)');
});

test('stories: throttle в per-метрик вызове пробрасывается (не глотается allSettled)', async () => {
  const { job } = makeJob((path, params) => {
    if (path === '/IG1/stories') return { data: [{ id: 'S1' }, { id: 'S2' }] };
    if (/^\/S\d+\/insights$/.test(path) && params.metric === 'views') throw throttle(429);
    if (/^\/S\d+\/insights$/.test(path)) return { data: [{ total_value: { value: 1 } }] };
    return benign(path, params);
  });
  await assert.rejects(job.collectIgForAccount(ACC, DAY), (e) => isIgThrottleError(e));
});
