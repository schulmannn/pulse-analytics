// ── Серверный «Неделя канала» для еженедельного report-email (фаза 3 нарратива) ──────────────
// Движок НЕ дублируется: тот же frontend/src/lib/narrative.ts собирается esbuild'ом в
// server/lib/narrative.gen.cjs (локально `npm run build:shared` во frontend/; в Docker — стадия
// frontend). Нет артефакта (dev без сборки, CI test-job) → секция письма тихо опускается и
// письмо-ссылка уходит как раньше: рассылка НИКОГДА не блокируется рассказом.
//
// Вход собирается из АРХИВА (channel_daily / posts / ig_daily), не из live-графа: письмо уходит
// утром понедельника, вчерашние сутки закрыты кроном — today-lag здесь не существует по построению.

let engine = null;
let engineTried = false;
function loadEngine() {
  if (engineTried) return engine;
  engineTried = true;
  try {
    engine = require('./narrative.gen.cjs');
  } catch {
    engine = null;
    console.log('[digest] narrative.gen.cjs отсутствует — секция «Неделя канала» в письмах выключена (frontend: npm run build:shared)');
  }
  return engine;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** ERV поста: доверяем сохранённой колонке; нет её — та же формула, что postErv фронта
 *  (вовлечения на просмотр, %). */
function postErv(p) {
  if (p.erv != null && Number.isFinite(Number(p.erv))) return Number(p.erv);
  const views = Number(p.views || 0);
  if (views <= 0) return 0;
  return ((Number(p.reactions || 0) + Number(p.forwards || 0) + Number(p.replies || 0)) / views) * 100;
}

/**
 * Чистая сборка NarrativeInput из архивных строк PG. Семантика зеркалит фронтовые входы:
 * viewsDaily = channel_daily.views (14д, старые→новые); посты недели + avgErv по 4-недельной
 * базе (гейт ≥3 поста с охватом — как tgWeekMetrics); subsD7 = уровень − уровень ≤(now−7д)
 * (по ДНЯМ, не по индексу — дыры в архиве не ломают окно). IG-кода: reachDaily (дневной ряд —
 * серверу дедуп-окно Graph недоступно, движок честно падает на daily-fallback igReachWindow),
 * followsDaily = НЕТТО follows−unfollows подневно (канон PR #100), followersNow = null —
 * честного УРОВНЯ базы в архиве нет (ig_daily.followers = gross-приход), движок сам опустит
 * «— сейчас N».
 */
function assembleWeekInput({ daily = [], posts = [], igDaily = [] }, nowMs = Date.now()) {
  const sinceMs = (days) => nowMs - days * DAY_MS;

  const viewsDaily = daily
    .filter((r) => r.views != null && Date.parse(r.day) >= sinceMs(14))
    .map((r) => ({ day: r.day, v: Number(r.views) }));

  const dated = posts.filter((p) => p.date_published && Number.isFinite(Date.parse(p.date_published)));
  const weekPosts = dated.filter((p) => nowMs - Date.parse(p.date_published) <= 7 * DAY_MS);
  const posts4w = dated.filter((p) => nowMs - Date.parse(p.date_published) <= 28 * DAY_MS);
  const ervBase = posts4w.filter((p) => Number(p.views) > 0);
  const avgErv = ervBase.length >= 3 ? ervBase.reduce((a, p) => a + postErv(p), 0) / ervBase.length : null;

  const levels = daily.filter((r) => r.subscribers != null);
  const last = levels.length ? levels[levels.length - 1] : null;
  const weekAgo = [...levels].reverse().find((r) => Date.parse(r.day) <= nowMs - 7 * DAY_MS) || null;
  const subsNow = last ? Number(last.subscribers) : null;
  const subsD7 = last && weekAgo ? Number(last.subscribers) - Number(weekAgo.subscribers) : null;

  const reachDaily = igDaily
    .filter((r) => r.reach != null && Date.parse(r.day) >= sinceMs(14))
    .map((r) => ({ day: r.day, v: Number(r.reach) }));
  const followsDaily = igDaily
    .filter((r) => r.follows != null)
    .map((r) => ({ day: r.day, v: Number(r.follows) - Number(r.unfollows ?? 0) }));
  const ig = reachDaily.length
    ? { reachDaily, followsDaily, followersNow: null, mediaWeek: [], avgMediaErv: null }
    : undefined;

  return {
    viewsDaily,
    posts: weekPosts.map((p) => ({
      title: (p.caption || 'Пост без текста').slice(0, 80),
      views: Number(p.views || 0),
      reactions: Number(p.reactions || 0),
      forwards: Number(p.forwards || 0),
      replies: Number(p.replies || 0),
      erv: postErv(p),
    })),
    avgErv,
    subsNow,
    subsD7,
    ig,
  };
}

/** Гейт: отчёт содержит preset-блок 'week' (или legacy 'digest' — рендерит тот же рассказ). */
function reportHasWeekBlock(config) {
  const blocks = config && Array.isArray(config.blocks) ? config.blocks : [];
  return blocks.some(
    (b) => b && b.type === 'preset' && b.config && (b.config.key === 'week' || b.config.key === 'digest'),
  );
}

const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** narrativeToPlain → простые <p> для письма (абзацы движка разделены \n\n). null = секции нет
 *  (движок не собран / рассказ пуст) — письмо уходит без неё. */
function weekSectionHtml(input) {
  const eng = loadEngine();
  if (!eng) return null;
  const plain = eng.narrativeToPlain(eng.buildWeekNarrative(input));
  if (!plain || !plain.trim()) return null;
  const paras = plain
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 10px;line-height:1.55">${escHtml(p)}</p>`)
    .join('');
  return `<h3 style="margin:18px 0 8px;font-size:15px">Неделя канала</h3>${paras}`;
}

module.exports = { assembleWeekInput, reportHasWeekBlock, weekSectionHtml, loadEngine };
