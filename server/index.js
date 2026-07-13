// ═══════════════════════════════════════════════════════════════
//  Atlavue — Backend Server
//  Node.js + Express
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const rateLimit  = require('express-rate-limit');
const crypto     = require('crypto');
const db         = require('./db');
const { hashPassword, verifyPassword, rateLimitKey } = require('./lib/auth');
const { captionSnippet } = require('./lib/caption');
const { fetchWithTimeout } = require('./lib/http');
const { MTPROTO_TOKEN, MTPROTO_TIMEOUT_HEAVY_MS, mtprotoFetch, mtprotoPost } = require('./lib/mtproto-client');
const { log } = require('./lib/observability');
const { makeResolveChannel, hasWorkspaceRole } = require('./middleware/tenant');
const { loadConfig } = require('./config');
const { createApp } = require('./app');
const { createAuthService } = require('./services/authService');
const { createEmailService } = require('./services/emailService');
const { createAuditService } = require('./services/auditService');
const { createInstagramClient } = require('./infrastructure/instagramClient');
const { createInstagramCollectionJob } = require('./jobs/instagramCollectionJob');
// Единственная точка чтения process.env — config.js (все env-чтения проведены на config.*).
const config = loadConfig(process.env);

// История (Postgres): dbReady гейтит data-роуты, пока идёт миграция. Сама boot-цепочка
// (bootPromise) стартует ниже — после создания authService, чьи bootstrapAdmin/
// claimOwnerChannel она зовёт (destructured const не хойстится, в отличие от прежних
// function-деклараций).
let dbReady = false;


// General read limiter for the authed dashboard (~9 reads per refresh). Keyed PER
// USER, not per IP: behind Railway's proxy `trust proxy: 1` can resolve req.ip to a
// shared upstream address, so an IP-keyed limit would be effectively global — one
// user (or an external probe hitting /api/health etc.) could throttle everyone,
// surfacing as "Источники недоступны" and login "Слишком много запросов". A signed
// session token can't be forged and parseToken (defined below) rejects garbage, so
// keying by uid is safe and token-rotation can't escape it; unauthenticated requests
// fall back to a per-IP bucket. 600/15min is generous for real dashboard usage.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  keyGenerator: (req) => rateLimitKey(parseToken(req.headers['x-session-token']), req.ip),
  message: { error: 'Слишком много запросов. Попробуй через 15 минут.' }
});

// Stricter limiter for auth endpoints (brute-force / enumeration hardening).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Слишком много попыток входа. Подожди 15 минут.' }
});

// ── Авторизация: stateless HMAC-токены (переживают рестарт/редеплой) ──
// Весь auth-домен — services/authService.js (PR C): секрет + подписанты сессий,
// requireAuth/requireSuper, бутстрап админа, утилиты auth-флоу (email-токены,
// DUMMY_HASH). Boot-fatal чек секретов — validateConfig в main.js. index раздаёт
// поля сервиса в createApp deps — сам deps-контракт app.js не менялся.
const authService = createAuthService({ config, db });
const {
  AUTH_SECRET, SESSION_TTL, GOOGLE_CLIENT_ID,
  signSession, parseToken,
  VERIFY_TTL, RESET_TTL, sha256, newToken, DUMMY_HASH,
  bootstrapAdmin, claimOwnerChannel,
  requireAuth, requireSuper,
} = authService;

// Журнал действий — services/auditService.js (IP_HASH_KEY выводится внутри из AUTH_SECRET).
const { audit } = createAuditService({ db, authSecret: AUTH_SECRET });

// Поднимаем схему, если БД подключена; после схемы — бутстрап админ-аккаунта, затем
// привязка central-канала к админу. main.js ждёт bootPromise ДО listen. Цепочка НИКОГДА
// не reject'ится: сбой БД логируется (db_init_failed), dbReady=false, сервер всё равно
// поднимается (health 200 / ready 503) — прежнее DB-стойкое поведение.
const bootPromise = db.init().then(bootstrapAdmin).then(claimOwnerChannel).then(() => { dbReady = true; })
  .catch(e => { log('error', 'db_init_failed', { error: e.message }); dbReady = false; });

// ── Channel (tenant) resolution & isolation ──────────────────────
const resolveChannel = makeResolveChannel({ db, isReady: () => dbReady });

// ── In-memory кэш ───────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || entry.expires < Date.now()) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data, ttl = CACHE_TTL) {
  // Bounded: the key space (per-channel × per-param) is otherwise unbounded and
  // grows into a slow memory leak. Evict the oldest entry (insertion order ≈ age).
  if (!cache.has(key) && cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { data, expires: Date.now() + ttl });
}
// Expired entries used to be reaped only on re-read, so one-off keys lingered for
// the process lifetime. unref(): the sweep must not hold the process open (tests).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expires < now) cache.delete(key);
}, 60 * 1000).unref();

// Clamp a user-supplied numeric option to the nearest allowed value BEFORE it becomes
// a cache key — otherwise every distinct value is its own cache miss and a fresh
// burst of upstream (Graph) calls.
const nearestOf = (value, allowed) =>
  allowed.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best));

// ── Email (verification / password reset / reports) — services/emailService ──
// Resend-отправка, HTML-шаблоны и appBase (публичный origin для ссылок в письмах,
// anti Host-poisoning c TRUSTED_HOSTS/CANONICAL_ORIGIN) — services/emailService.js.
// APP_URL-warn для prod печатает сервис при создании (тот же module-load момент).
const emailService = createEmailService({ config });
const { sendEmail, emailShell, emailBtn, appBase, escHtml } = emailService;
const emailConfigured = emailService.configured;

// Constant-time secret compare. Raw `!==` leaks length/prefix timing; timingSafeEqual
// throws on length mismatch — comparing fixed-length digests avoids both. (Остаётся в
// index: единственный потребитель — ingest-гейт; уедет в dailyIngestJob в PR E.)
const timingSafeEqualStr = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest());




// ════════════════════════════════════════════════════════════════
//  INSTAGRAM ROUTES
// ════════════════════════════════════════════════════════════════

// "Instagram API with Instagram Login" (no Facebook Page): the IG user access token works
// against graph.instagram.com, NOT graph.facebook.com. IG_ACCESS_TOKEN/IG_ACCOUNT_ID is the
// global single-account fallback; per-channel OAuth tokens (ig_accounts) layer on top and take
// precedence when a channel has connected its own account (see resolveIg in routes/ig.js).
// `|| undefined` сохраняет прежнюю undefined-семантику (config дефолтит ''): igFetch
// default-параметр и все falsy-проверки ведут себя байт-в-байт как при чтении env напрямую.
const IG_TOKEN     = config.instagram.accessToken || undefined;
const IG_ACCOUNT   = config.instagram.accountId || undefined;
const igCrypto     = require('./lib/ig_crypto');
const tgCrypto     = require('./lib/tg_crypto');
const igMock       = require('./ig_mock');
// Global env single-account is "configured" when both token + account id are present.
// (The per-channel OAuth connect flow + its app credentials live in routes/ig-oauth.js.)
const igConfigured = () => !!IG_TOKEN && !!IG_ACCOUNT;

// Graph-клиент (singleflight igFetch + opportunistic refreshIgIfNeeded) — infrastructure/
// instagramClient. defaultToken = глобальный env-токен: legacy-вызовы без 3-го аргумента
// работают как раньше; live-роуты и дневной cron-сбор делят ОДИН клиент.
const igClient = createInstagramClient({ db, log, igCrypto, defaultToken: IG_TOKEN });
const { igFetch, refreshIgIfNeeded, IG_GRAPH } = igClient;
// Дневной IG-сбор для крона — jobs/instagramCollectionJob (processPersistence ниже зовёт его
// per-account; каждый сбой изолирован внутри job и не касается ответа крона).
const igCollectionJob = createInstagramCollectionJob({ db, log, igCrypto, igFetch, refreshIgIfNeeded });
const collectIgForAccount = igCollectionJob.collectIgForAccount;


// Оркестратор персистенса (вызывается fire-and-forget ПОСЛЕ ответа крона):
//   (a) сырой снимок TG /graphs для центрального канала (catch-all для серий, которые
//       не ложатся в channel_daily: views_by_source, languages, top_hours и т.п.);
//   (b) IG-сбор по КАЖДОМУ аккаунту из ig_accounts (не только центральный — IG цепляется
//       к любому каналу), ПОСЛЕДОВАТЕЛЬНО, чтобы не устраивать thundering herd;
//   (c) прунинг raw_snapshots. Ничего не бросает наружу.
async function processPersistence(centralChannelId, graphs) {
  if (!db.enabled) return;
  const day = new Date().toISOString().slice(0, 10);
  // (a) сырой TG /graphs — payload уже в руках (лишнего mtproto-вызова нет).
  if (centralChannelId && graphs && graphs.available) {
    try { await db.saveRawSnapshot(centralChannelId, 'tg', 'graphs', day, graphs); }
    catch (e) { log('error', 'tg_graphs_snapshot_failed', { channelId: centralChannelId, error: e.message }); }
  }
  // (b) IG по каждому подключённому аккаунту. Без IG_TOKEN_KEY токенов нет — пропускаем.
  //     Гейтим ДНЕВНОЙ джобой (runJobOnce per день, lease 1ч): 504ca50 ввёл same-day-ретрай
  //     degraded-дня, а IG-фан-аут НЕ идемпотентен по квоте (upsert'ы идемпотентны, но каждый
  //     прогон заново жжёт Graph-квоту). Под гейтом ТОЛЬКО IG — (a) сырой TG-снимок идёт каждый
  //     раз, чтобы recovered-ретрай не потерял /graphs (узкая часть a2cbcc4-гейта).
  if (igCrypto.configured()) {
    await db.runJobOnce('ig_persistence', `central:${day}`, async () => {
      let accounts = [];
      try { accounts = await db.listIgAccounts(); }
      catch (e) { log('error', 'ig_list_accounts_failed', { error: e.message }); }
      for (const acc of accounts) {
        try { await collectIgForAccount(acc, day); }   // sequential: по-доброму к квоте
        catch (e) { log('error', 'ig_collect_account_failed', { channelId: acc && acc.channel_id, error: e.message }); }
      }
    }, { leaseSeconds: 60 * 60 }).catch(e => log('warn', 'ig_persistence_gate_failed', { error: e.message }));
  }
  // (c) ретеншн — не даём append-only таблицам расти безгранично.
  try { await db.pruneRawSnapshots(); }
  catch (e) { log('error', 'raw_snapshots_prune_failed', { error: e.message }); }
  try { await db.pruneIgMediaDaily(); }
  catch (e) { log('error', 'ig_media_daily_prune_failed', { error: e.message }); }
  // (d) capacity: nightly monthly rollup of channel_daily (ops/CAPACITY_SCALE_1K_10K.md). INERT by
  // default — only runs when CAPACITY_ROLLUPS=1, and the jobs row makes exactly one web instance
  // recompute it per day (idempotent, cheap: bounded to recent months). Nothing reads channel_monthly
  // yet, so this is groundwork; enable it before wiring the long-range history reader.
  if (config.runtime.capacityRollups) {
    const rollupKey = `channel_monthly:${day}`;
    try { await db.runJobOnce('rollup_channel_monthly', rollupKey, () => db.rollupChannelMonthly(3)); }
    catch (e) { log('error', 'channel_monthly_rollup_failed', { error: e.message }); }
  }
}

// One mtproto post ({id,date,views,reactions,forwards,replies,media_type,text,hashtags}) → a
// posts-table row. Shared by the central ingest and the QR-channel collection so both compute ERV/
// virality identically.
function tgPostToRow(p) {
  const reach = p.views || 0;
  const eng = (p.reactions || 0) + (p.forwards || 0) + (p.replies || 0);
  return {
    post_id: p.id, date_published: p.date,
    views: p.views || 0, reactions: p.reactions || 0, forwards: p.forwards || 0, replies: p.replies || 0,
    erv: reach > 0 ? eng / reach * 100 : null,
    virality: reach > 0 ? (p.forwards || 0) / reach * 100 : null,
    media_type: p.media_type, caption: captionSnippet(p.text), hashtags: p.hashtags || [],
  };
}

// Write one channel's collected bundle to Postgres exactly like a collector push: the snapshot
// (what /api/tg/full + the /api/tg/mtproto/* routes serve for non-central channels) plus the
// time-series (channel_daily from graphs, posts). Best-effort per part.
async function persistTgBundle(channelId, bundle, day) {
  if (!channelId || !bundle || typeof bundle !== 'object') return;
  const posts = Array.isArray(bundle.posts) ? bundle.posts : [];
  const hasGraphs = !!(bundle.graphs && bundle.graphs.available);
  // Снапшот + daily + посты коммитятся ВМЕСТЕ (db.persistTgBundleTx) — раньше это были
  // отдельные автокоммитные записи, и сбой посередине оставлял QR-канал со свежим
  // снапшотом, но устаревшими daily/posts до следующего идемпотентного прогона.
  await db.persistTgBundleTx(channelId, {
    snapshot: {
      channel:       bundle.channel || {},
      views_summary: bundle.views_summary || null,
      posts,
      stats:         bundle.stats || null,
      graphs:        bundle.graphs || null,
    },
    dailyRows: hasGraphs ? db.graphsToDailyRows(bundle.graphs) : [],
    postRows: posts.map(tgPostToRow),
  });
  // Сырой graphs-снимок — опциональный архив: best-effort ПОСЛЕ коммита, как раньше,
  // но с логом (тихий .catch(() => {}) прятал реальные, actionable-ошибки записи).
  if (hasGraphs) {
    await db.saveRawSnapshot(channelId, 'tg', 'graphs', day, bundle.graphs).catch((e) =>
      log('warn', 'tg_qr_raw_snapshot_failed', { channelId, error: e.message }));
  }
}

// Fetch one QR channel's bundle via the (already-decrypted) session and persist it. Throws on
// mtproto/collect failure — callers decide how to handle (log + continue).
async function collectQrChannel(sessionStr, ch, day) {
  const ref = ch.username || String(ch.tg_channel_id);
  const bundle = await mtprotoPost('/qr/collect', {
    body: { session: sessionStr, channel: ref, posts_limit: 100, graph_points: 400 },
    timeoutMs: MTPROTO_TIMEOUT_HEAVY_MS,
  });
  await persistTgBundle(ch.id, bundle, day);
}

// Immediate best-effort collection for freshly-added channels so the dashboard fills within seconds
// instead of waiting for the nightly cron. Fire-and-forget; sequential (kind to the user's session's
// flood limits); never throws to the caller.
async function collectQrChannelsNow(sess, channels) {
  if (!sess || !tgCrypto.configured() || !MTPROTO_TOKEN) return;
  let sessionStr;
  try { sessionStr = tgCrypto.decrypt(sess.session_enc); } catch { return; }
  const day = new Date().toISOString().slice(0, 10);
  for (const ch of channels) {
    if (!ch || ch.tg_channel_id == null) continue;
    try { await collectQrChannel(sessionStr, ch, day); }
    catch (e) { log('error', 'tg_qr_collect_now_failed', { channelId: ch.id, error: e.message }); }
  }
}

// Collect QR-connected channels (source='qr') into Postgres using each user's stored session — the
// server acts as their collector, so the dashboard renders them like any collector channel. Runs
// fire-and-forget after the central ingest; durable per (channel, day) so a repeat trigger resumes
// unfinished channels; sequential + per-channel try/catch so one bad session / channel / FloodWait
// never blocks the others or the critical central ingest. Sessions are decrypted ONLY here and handed
// to the isolated mtproto /qr/collect — never logged, never sent to a client.
const TG_QR_MAX_CHANNELS_PER_RUN = 200;

async function processTgQrCollection() {
  if (!db.enabled || !tgCrypto.configured() || !MTPROTO_TOKEN) return;
  const day = new Date().toISOString().slice(0, 10);
  let sessions = [];
  try { sessions = await db.listTgSessions(); }
  catch (e) { log('error', 'tg_qr_list_sessions_failed', { error: e.message }); return; }

  let done = 0, collected = 0, skipped = 0, failed = 0, capped = false;
  for (const s of sessions) {
    if (done >= TG_QR_MAX_CHANNELS_PER_RUN) { capped = true; break; }
    let sessionStr;
    try { sessionStr = tgCrypto.decrypt(s.session_enc); }
    catch { log('error', 'tg_qr_decrypt_failed', { uid: s.uid }); continue; }

    let chans = [];
    try { chans = (await db.listChannels({ uid: s.uid })).filter((c) => c.source === 'qr' && c.tg_channel_id != null); }
    catch (e) { log('error', 'tg_qr_list_channels_failed', { uid: s.uid, error: e.message }); continue; }

    for (const ch of chans) {
      if (done >= TG_QR_MAX_CHANNELS_PER_RUN) { capped = true; break; }
      let started = false;
      try {
        const out = await db.runJobOnce('qr_collect', `${ch.id}:${day}`, () => {
          started = true;
          return collectQrChannel(sessionStr, ch, day);
        });
        if (out.skipped) { skipped++; continue; }
        done++;
        collected++;
      }
      catch (e) {
        if (started) done++;
        failed++;
        log('error', 'tg_qr_collect_failed', { channelId: ch.id, error: e.message });
      }
    }
  }
  log(capped ? 'warn' : 'info', 'tg_qr_collection_done', { collected, skipped, failed, capped });
}


// ── Telegram Bot API env — read here; still surfaced by /api/health + the boot banner, and
// injected into routes/tg.js (which owns the Bot-API fetch helper and the /api/tg/* handlers). ──
const TG_TOKEN   = config.telegram.botToken || undefined;   // || undefined — как IG выше
const TG_CHANNEL = config.telegram.channel || undefined;


/* Email-выгрузка отчётов (v1). Дёргается fire-and-forget из дневного ingest-крона
   (единственный ежедневный тик системы — отдельного планировщика нет): weekly уходит
   в понедельник UTC, monthly — 1-го числа UTC. Если крон в «свой» день не сработал,
   действует catch-up: weekly шлётся, когда last_sent_at старше 8 дней, monthly — 32
   дней (первая отправка якорится к понедельнику / 1-му). Окно по last_sent_at в
   listDueReports остаётся анти-дублем, если крон сработал дважды за день. Все ошибки
   логируются и никогда не влияют на ответ ingest-а. */
// Серверный «Неделя канала» (фаза 3 нарратива): shared-движок narrative.gen.cjs + сборка входа
// из архива. Секция опциональна — без артефакта/данных письмо-ссылка уходит как раньше.
const { assembleWeekInput, reportHasWeekBlock, weekSectionHtml } = require('./lib/weekDigest');

const reportEmailHtml = (base, report, weekHtml) => emailShell(`Отчёт „${escHtml(report.name)}“`,
  `${weekHtml || ''}<p>Ваш регулярный отчёт Atlavue готов:</p>${emailBtn(`${base}/reports/${report.id}`, 'Открыть отчёт')}` +
  `<p style="color:#64748d;font-size:13px">Отчёт можно сохранить как PDF — кнопка «Печать» на странице отчёта.</p>`);

async function processReportSchedules(base) {
  if (!db.enabled) return;
  // Без почтового провайдера рассылка невозможна: dev-заглушка sendEmail вернула бы true,
  // и last_sent_at проставился бы без единого отправленного письма.
  if (!emailConfigured()) {
    console.log('[reports] schedule skipped: email not configured');
    return;
  }
  const now = new Date();
  const isMonday = now.getUTCDay() === 1;    // понедельник UTC
  const isFirst  = now.getUTCDate() === 1;   // 1-е число UTC
  let candidates = [];
  try { candidates = await db.listDueReports({ weekly: true, monthly: true }); }
  catch (e) { log('error', 'report_schedule_query_failed', { error: e.message }); return; }
  // Пер-строчный гейт с catch-up вместо строгого «только в понедельник / 1-го»: если крон
  // в тот день не сработал, письмо уходит, как только last_sent_at старше 8 дней (weekly)
  // или 32 дней (monthly). Первая отправка (last_sent_at IS NULL) якорится к понедельнику /
  // 1-му. Анти-дубль в течение дня остаётся SQL-окном в listDueReports.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const olderThan = (sentAt, limitDays) =>
    sentAt != null && now.getTime() - new Date(sentAt).getTime() > limitDays * DAY_MS;
  const due = candidates.filter((r) =>
    r.schedule === 'weekly'
      ? isMonday || olderThan(r.last_sent_at, 8)
      : isFirst  || olderThan(r.last_sent_at, 32));
  // ISO-week key (YYYY-Www) so the weekly job key is stable across the whole week.
  const isoWeekKey = (d) => {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // Thursday of this ISO week
    const week = Math.ceil((((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000) + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };
  for (const r of due) {
    // Idempotency key per (report, period): a double cron tick, the catch-up branch firing next
    // to the anchored one, or a SECOND SERVER INSTANCE can all re-discover the same candidate —
    // the jobs row makes exactly one of them send (roadmap P0 «Background job idempotency»).
    const periodKey = r.schedule === 'weekly' ? isoWeekKey(now) : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    try {
      const outcome = await db.runJobOnce('report_email', `report:${r.id}:${periodKey}`, async () => {
        // GDPR-гонка: юзер мог стереть аккаунт между снапшотом listDueReports (несёт email в
        // строке) и отправкой — перепроверяем существование, письмо на стёртый адрес не уходит.
        if (!(await db.getUserById(r.uid))) return { sent: false, erased: true };
        // «Неделя канала» в теле письма — только weekly-отчётам с week/digest-блоком. Любая
        // ошибка сборки секции НЕ роняет отправку: письмо уходит без неё (рассказ — бонус).
        let weekHtml = null;
        try {
          if (r.schedule === 'weekly' && reportHasWeekBlock(r.config)) {
            const chans = await db.listChannels({ uid: r.uid });
            // Канал нарратива = канал САМОГО ОТЧЁТА (config.channelId — то, что рендерит
            // страница /reports/:id, куда ведёт кнопка письма). Раньше всегда брался chans[0]
            // (старейший канал юзера): письмо ссылалось на отчёт канала B, а цифры внутри были
            // канала A. Членство в chans = ownership-check; чужой/удалённый id → прежний фолбэк.
            const cfgId = Number(r.config && r.config.channelId) || 0;
            const chId = (cfgId && chans.some((c) => c.id === cfgId))
              ? cfgId
              : (chans[0] && chans[0].id);
            if (chId) {
              // Internal-ридеры (cron): доступ уже установлен членством chans выше (listChannels).
              const [daily, posts, igDaily] = await Promise.all([
                db.getChannelHistoryInternal(chId, 35),
                db.listPostsWindow(chId, 28),
                db.listIgDailyInternal(chId, 14),
              ]);
              weekHtml = weekSectionHtml(assembleWeekInput({ daily, posts, igDaily }));
            }
          }
        } catch (e) {
          log('warn', 'report_week_section_failed', { report_id: r.id, error: e.message });
        }
        const ok = await sendEmail(r.email, `Atlavue — отчёт „${r.name}“`, reportEmailHtml(base, r, weekHtml));
        if (ok) await db.markReportSent(r.id);
        if (!ok) throw new Error('email send failed');
        return { sent: true };
      });
      if (outcome.skipped) {
        log('info', 'report_email_deduped', { report_id: r.id, period: periodKey });
      }
    } catch (e) {
      log('error', 'report_email_failed', { report_id: r.id, error: e.message });
    }
  }
}


// ════════════════════════════════════════════════════════════════
//  TELEGRAM — Bot API + QR-connect + MTProto proxy routes → routes/tg.js
// ════════════════════════════════════════════════════════════════

// Public media proxies (thumb / channel photo) are open <img src> routes, so beyond the global
// /api limiter they get a dedicated modest per-IP limiter to keep an anonymous scraper from
// hammering the MTProto service. Defined here with the other rate limiters and injected into the
// TG routes.
const mediaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Слишком много запросов. Попробуй через минуту.' }
});



// Единая сборка HTTP-app: все env/БД/таймер-зависимые хелперы построены выше и
// инъектируются в createApp (server/app.js). getDbReady читает живой флаг миграции dbReady.
const app = createApp({
  config, db, log,
  fetchWithTimeout, mtprotoFetch, MTPROTO_TIMEOUT_HEAVY_MS,
  requireAuth, requireSuper, resolveChannel, audit,
  getDbReady: () => dbReady,
  limiter, authLimiter, mediaLimiter,
  hashPassword, verifyPassword, DUMMY_HASH, signSession, SESSION_TTL, GOOGLE_CLIENT_ID,
  appBase, sha256, newToken, VERIFY_TTL, RESET_TTL, sendEmail, emailShell, emailBtn, escHtml,
  igFetch, refreshIgIfNeeded, igConfigured, igCrypto, igMock, nearestOf,
  cacheGet, cacheSet, cache, IG_ACCOUNT, IG_TOKEN, IG_GRAPH, AUTH_SECRET,
  tgCrypto, collectQrChannelsNow, TG_TOKEN, TG_CHANNEL,
  timingSafeEqualStr, tgPostToRow, processReportSchedules, processPersistence, processTgQrCollection,
});

// ── Запуск ──────────────────────────────────────────────────────
// Lifecycle (validateConfig → await bootPromise → listen + баннер + single-replica
// guardrail) живёт в main.js; index остаётся compat-entry (`npm start` = node server/
// index.js) и точкой сборки deps до их переезда в services/jobs (PR C-E).
module.exports = { app, config, bootPromise };

if (require.main === module) {
  // Жёсткий exit(1), как раньше делал inline-чек секретов: ConfigError в prod не должен
  // оставлять процесс висеть на открытых хендлах (pg pool), Railway рестартует по коду.
  require('./main').main().catch((e) => {
    console.error('[boot] fatal:', e && e.message);
    process.exit(1);
  });
}
