import { expect, test, type Page } from '@playwright/test';

/**
 * IG feed period morph — карточка «Охват» на /instagram обязана ПЕРЕТЕКАТЬ из формы одного периода
 * в форму другого (тот же контракт MorphingSeries, что у TG-обзора и metric explorer), а не
 * проваливаться в полностраничный скелетон, пока грузится перекеченный ig-insights.
 *
 * Регрессия: useIgInsights перекеивается на каждой смене периода; без placeholderData вся оболочка
 * IG подменялась <InstagramSkeleton />, график размонтировался, и морф-движку было нечего
 * интерполировать.
 *
 * ПОЧЕМУ СПЕК ПЕРЕПИСАН (аудит #554). Прежняя версия бутилась через bootDemo и вешала задержку
 * роутом поверх демо. Демо-фикстуры отдают IG-пути КЛИЕНТСКИ, до сети, поэтому route-стаб не
 * срабатывал НИ РАЗУ — проверено счётчиком попаданий: 0. Тест был зелёным и не воспроизводил ту
 * самую медленную догрузку, ради которой существовал. Здесь весь IG-набор стабится роутами без
 * pulse_demo, и задержка на insights — настоящая.
 */

const SEC = 86_400;
const nowSec = Math.floor(Date.now() / 1000);
const dayIso = (offset: number) => new Date((nowSec + offset * SEC) * 1000).toISOString();

/** Дневной ряд охвата: длина и форма зависят от окна, иначе морфу не во что перетекать. */
function insightsFor(days: number) {
  const points = Math.min(days, 90);
  const reach = Array.from({ length: points }, (_, i) => ({
    value: 1000 + Math.round(Math.sin(i / (days === 90 ? 9 : 3)) * 400) + i * (days === 90 ? 2 : 7),
    end_time: dayIso(i - points),
  }));
  const follower = Array.from({ length: points }, (_, i) => ({
    value: 20_000 + i * 3,
    end_time: dayIso(i - points),
  }));
  const agg = (name: string, cur: number, prev: number) => ({
    name,
    period: 'day',
    values: [
      { value: prev, end_time: dayIso(-points) },
      { value: cur, end_time: dayIso(0) },
    ],
    total_value: { value: cur },
  });
  return {
    data: [
      { name: 'reach', period: 'day', values: reach },
      { name: 'follower_count', period: 'day', values: follower },
      agg('views', days * 120, days * 100),
      agg('profile_views', days * 12, days * 10),
      agg('accounts_engaged', days * 9, days * 8),
      agg('total_interactions', days * 30, days * 26),
      agg('likes', days * 20, days * 18),
      agg('comments', days * 4, days * 3),
      agg('saves', days * 3, days * 2),
      agg('shares', days * 2, days * 1),
      agg('follows', days * 5, days * 4),
      agg('unfollows', days * 2, days * 2),
      agg('reach_window', days * 90, days * 80),
    ],
  };
}

const PROFILE = {
  username: 'bynotem', name: 'notem', followers_count: 20_500, follows_count: 300,
  media_count: 420, biography: '', website: '', profile_picture_url: null,
  synced_at: Date.now(),
};

/** Стенд IG без pulse_demo: каждый путь кластера отвечает роутом, задержка настоящая. */
async function bootIg(page: Page, { insightsDelayMs = 0 } = {}) {
  const insightsHits: number[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname === '/api/auth/me') {
      return json({ uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null });
    }
    if (url.pathname === '/api/channels' && request.method() === 'GET') {
      return json({
        enabled: true,
        channels: [{ id: 9, username: 'bynotem', title: 'bynotem', status: 'active', source: 'ig', ig_connected: true }],
      });
    }
    if (url.pathname === '/api/ig/oauth/status') {
      return json({
        server_ready: true, env_fallback: false, connected: true, channel_id: 9,
        username: 'bynotem', ig_user_id: 'igid123', connected_at: '2026-07-03T10:00:00',
        token_expires_at: dayIso(45), token_state: 'ok',
      });
    }
    if (url.pathname === '/api/ig/profile') return json(PROFILE);
    if (url.pathname === '/api/ig/insights') {
      const days = Number(url.searchParams.get('days') ?? 30);
      insightsHits.push(days);
      if (insightsDelayMs) await new Promise((r) => setTimeout(r, insightsDelayMs));
      return json(insightsFor(days));
    }
    if (url.pathname === '/api/ig/posts') return json({ data: [] });
    if (url.pathname === '/api/ig/history') return json({ rows: [] });
    if (url.pathname.startsWith('/api/ig/')) return json({ data: [] });
    if (url.pathname === '/api/tg/qr/status') return json({ connected: false, server_ready: false });
    if (url.pathname === '/api/prefs') return json({});
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_stubbed"}' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '9');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto('/instagram');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  return insightsHits;
}

test('instagram reach chart flows between periods without a skeleton swap', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-only period-morph budget');
  const insightsHits = await bootIg(page, { insightsDelayMs: 300 });
  const reachCard = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Охват', exact: true }),
  });
  // Канон-грамматика hero-карточки: безосевой area-Sparkline (TG-твин FeaturedKpi). Морф-контракт
  // тот же — SparklineSeries несёт data-chart-motion="morph" и data-chart-series="primary".
  const chart = reachCard.locator('svg[data-chart-kind="sparkline"]').first();
  await chart.waitFor({ state: 'visible', timeout: 15_000 });
  const primarySeries = chart.locator('[data-chart-series="primary"]');
  const morphGroup = chart.locator('g[data-chart-motion="morph"]').first();
  await expect(morphGroup).toHaveAttribute('data-chart-morph-state', 'idle');
  const morphNode = await morphGroup.elementHandle();
  if (!morphNode) throw new Error('reach morph group has no element handle');
  const oldPath = await primarySeries.getAttribute('d');
  if (!oldPath) throw new Error('reach path is empty before period change');

  // The IG feed defaults to 30д. Switch to 90д — the one preset with a COLD ig-insights cache:
  // «Неделя аккаунта» pre-fetches the 7/14-day keys at boot, so a 30→7 swap is always cache-warm
  // and never reproduced the skeleton regression. 30→90 forces the delayed refetch above.
  // Sample every browser frame so a fast polling client cannot miss the running state.
  const pagePeriod = page.getByRole('group', { name: 'Период', exact: true });
  await expect(pagePeriod.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');
  await chart.evaluate((svg) => {
    const state = window as unknown as {
      __igMorphFrames: Array<{ primary: string; state: string | null }>;
      __igMorphDone: boolean;
    };
    state.__igMorphFrames = [];
    state.__igMorphDone = false;
    const startedAt = performance.now();
    let sawRunning = false;
    const sample = () => {
      const group = svg.querySelector('g[data-chart-motion="morph"]');
      const primary = svg.querySelector('[data-chart-series="primary"]');
      const current = group?.getAttribute('data-chart-morph-state') ?? null;
      sawRunning = sawRunning || current === 'running';
      state.__igMorphFrames.push({
        primary: primary?.getAttribute('d') ?? '',
        state: current,
      });
      // Settle-aware horizon: sample until the morph that started has come back to idle (или 4с
      // cap — на нагруженном раннере 1500мс морф стартует с запозданием, и жёсткое окно резало
      // его mid-flight). Регрессионный кейс (морф не стартовал) закрывает cap.
      if (performance.now() - startedAt < 4000 && !(sawRunning && current === 'idle')) {
        requestAnimationFrame(sample);
      } else {
        state.__igMorphDone = true;
      }
    };
    requestAnimationFrame(sample);
  });
  await pagePeriod.getByRole('button', { name: '90д', exact: true }).click();
  // Ждём остановки сэмплера (settle либо cap), затем судим по собранным кадрам — так и зелёный,
  // и регрессионный прогон падают ИНФОРМАТИВНО (morphEvidence), а не generic-таймаутом.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __igMorphDone: boolean }).__igMorphDone), {
      timeout: 6_000,
    })
    .toBe(true);
  const frames = await page.evaluate(() => (window as unknown as {
    __igMorphFrames: Array<{ primary: string; state: string | null }>;
  }).__igMorphFrames);
  const finalPath = await primarySeries.getAttribute('d');
  // The load-bearing regression assertion: the SAME morph group element survived the period
  // change — the shell never swapped the view for the loading skeleton mid-refetch.
  const sameMorphNode = await morphGroup.evaluate((element, previousElement) => element === previousElement, morphNode);
  const morphEvidence = JSON.stringify({
    sameMorphNode,
    states: [...new Set(frames.map((frame) => frame.state))],
    distinctPaths: new Set(frames.map((frame) => frame.primary)).size,
    pathChanged: finalPath !== oldPath,
  });

  expect(sameMorphNode, morphEvidence).toBe(true);
  expect(frames.some((frame) => frame.state === 'running'), morphEvidence).toBe(true);
  expect(frames.at(-1)?.state).toBe('idle');
  expect(finalPath).not.toBe(oldPath);
  // Real interpolation happened: at least one sampled shape is neither the start nor the end.
  expect(frames.some((frame) => frame.primary.length > 0 && frame.primary !== oldPath && frame.primary !== finalPath), morphEvidence).toBe(true);
  expect(frames.at(-1)?.primary).toBe(finalPath);
  await expect(morphGroup).toHaveAttribute('data-chart-morph-state', 'idle');

  /* Стаб задержки ОБЯЗАН был сработать. Прежняя версия спека вешала его поверх демо-фикстур,
     которые отдают IG-пути клиентски, и он не срабатывал ни разу — тест был зелёным, ничего не
     проверяя. Эта проверка не даёт спеку снова стать холостым. */
  expect(insightsHits, 'insights должен был запрашиваться через стаб').toContain(30);
  expect(insightsHits, 'смена периода обязана перезапросить insights на 90 дней').toContain(90);
});
