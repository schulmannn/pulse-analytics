// ═══════════════════════════════════════════════════════════════
//  Atlavue — догрузка истории Instagram в архив ig_daily (job)
// ═══════════════════════════════════════════════════════════════
// OD-13 (владелец, 2026-09-25): «для инсты сделай сохранения в базу данных по аналогии с тг».
// Дневной крон (instagramCollectionJob) снимает ровно «вчера», поэтому архив начинался с первого
// дня крона, а всё, что длиннее, упиралось в живые 90 дней Graph. Эта джоба идёт по UTC-дням НАЗАД
// от вчера−1 (вчера — день крона) и для каждого дня повторяет ТЕ ЖЕ однодневные запросы, что крон
// шлёт за «вчера» (collectIgDailyForDay) — строка бэкфилла значит ровно то же, что строка крона:
// одно окно [D, D+1), та же разность follows_and_unfollows, та же семантика UTC-дня (OD-8 не
// трогаем). ~11 вызовов Graph на день истории.
//
// Ключевые решения:
//   • Архив НЕ перезаписывается: день, где уже есть данные (крон, прошлый проход, чужая
//     идентичность), пропускается без вызовов. upsertIgDaily — COALESCE («не-null перезаписывает,
//     null не стирает»), а страж guardSource не даёт переподключённому другому аккаунту затереть
//     чужие строки. followers_total бэкфилл не шлёт — якорь уровня от крона сохраняется.
//   • Пропуск ≠ ноль: пустой день (Graph не отдал ни одной положительной метрики) НЕ пишется —
//     в архиве остаётся честная дыра. 7 пустых дней подряд = горизонт Graph (horizon_day), дальше
//     не ходим; глубже maxDays (730) не пробуем вовсе. Это граница опроса, а не потолок чтения.
//   • Квота прежде всего: проход идёт ПОСЛЕ дневного крона в той же IG-полосе через paced-клиент
//     (общий singleflight и usage-gate). Весь проход останавливается на открытом gate, на BUC ≥
//     bucStopPct, на исчерпанном времени прохода; аккаунт — на дневном бюджете вызовов. Throttle
//     (429, в т.ч. Graph 80002) — чекпойнт и проброс: чанк-джоба failed и повторяема.
//   • Возобновляемость: чекпойнт после каждого сходившего в Graph дня (cursor_day и счётчики в
//     ig_backfill_state) — рестарт повторяет максимум один день, а повтор безопасен (COALESCE).
//     Чанк клеймится runJobOnce('ig_backfill_chunk', ch:ig_user:эпоха:cursor_day:aN): 15-минутный lease
//     разводит web-kick и worker-проход, чанк без продвижения бросает паузу и остаётся повторяемым.
//   • Токен дешифруется ДО claim'а: битый ключ не сжигает чанк, состояние честно = error
//     (token_decrypt). Умерший токен → error ig_reauth; после переподключения (оно штампует
//     ig_accounts.updated_at) или через сутки аккаунт снова в кандидатах.
//   • Раз в UTC-сутки для завершённых аккаунтов (durable 'ig_daily_heal'): (а) доливка лага —
//     перезапрос вчера−1 и вчера−2 (Meta финализирует цифры до 48 ч; перезапись здесь намеренна);
//     (б) ремонт дыр/неполных дней за последние ~85 дней (простой, throttle на весь день, отказ
//     дешифровки, пустой день крона) — каждый день через memo 'ig_day_repair', чтобы честно пустой
//     день не жёг квоту каждые сутки.
// Без Express/env/таймеров: всё из deps, лимиты — из config через composition.

'use strict';

const { isIgThrottleError } = require('./instagramCollectionJob');
const { fmtDay, shiftDay } = require('../domain/period');

// Сколько вызовов Graph стоит один день истории: reach-серия + 8 total_value + 2 окна fau.
const CALLS_PER_DAY = 11;

const DEFAULT_LIMITS = Object.freeze({
  enabled: true,
  accountsPerPass: 3,
  daysPerPass: 14,
  dailyCalls: 1500,
  maxDays: 730,
  emptyStreak: 7,
  topupDays: 2,
  bucStopPct: 75,
  passBudgetMs: 240000,
  // Не из конфига — продуктовые константы ремонта: окно (в пределах живого follower_count/reach),
  // сколько дней чиним за сутки и сколько временных сбоев терпим на одном дне.
  healWindowDays: 85,
  healMaxDays: 14,
  maxDayAttempts: 3,
  // Сколько завершённых аккаунтов проверяем на дневной ремонт за проход (memo-ключ дня дешёвый).
  healAccountsPerPass: 25,
});

// Причины, по которым останавливается ВЕСЬ проход (а не один аккаунт).
const PASS_STOPS = new Set(['gate', 'buc', 'pass_budget']);

// Особая «пауза» чанка: продвижения не было (бюджет/стоп прохода) — runJobOnce пометит строку
// failed, чтобы следующий проход переклеймил тот же ключ, а не счёл чанк выполненным.
class BackfillPause extends Error {
  constructor(reason) {
    super(`ig_backfill_paused:${reason}`);
    this.igBackfillPause = true;
    this.reason = reason;
  }
}

function createIgBackfillJob({
  db, log = () => {}, igCrypto, refreshIgIfNeeded, collectIgDailyForDay, usageGate, limits = {}, now = Date.now,
} = {}) {
  const L = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(limits || {}).filter(([, v]) => v !== undefined)) };
  const gate = usageGate || { shouldStopPass: () => false, lastBucUsagePct: () => 0 };
  const bucPct = () => (typeof gate.lastBucUsagePct === 'function' ? Number(gate.lastBucUsagePct()) || 0 : 0);
  const today = () => fmtDay(now(), 'UTC');
  const minDay = (a, b) => (a && b ? (a < b ? a : b) : a || b || null);

  // Причина остановить ВЕСЬ проход (или null): открытый app-gate, BUC у порога, время прохода.
  function makeStopper(startedAt) {
    return () => {
      if (gate.shouldStopPass()) return 'gate';
      if (bucPct() >= L.bucStopPct) return 'buc';
      if (now() - startedAt >= L.passBudgetMs) return 'pass_budget';
      return null;
    };
  }

  // Дешифровка + opportunistic refresh ДО любого claim'а. null = токена нет (состояние уже error).
  async function openToken(acc) {
    let token;
    try {
      token = igCrypto.decrypt(acc.access_token_enc);
    } catch (e) {
      log('warn', 'ig_backfill_token_decrypt_failed', { channelId: acc.channel_id, error: e.message });
      await db.setIgBackfillState(acc.channel_id, {
        ig_user_id: acc.ig_user_id, status: 'error', error: 'token_decrypt',
      }).catch(() => {});
      return null;
    }
    return refreshIgIfNeeded(acc.channel_id, token, acc.token_expires_at);
  }

  // Состояние для текущей идентичности: сброс, если его нет, другая идентичность или проход ещё
  // не инициализирован; error той же идентичности (повтор через сутки / после reconnect) — снова running.
  async function ensureState(acc) {
    const state = await db.getIgBackfillState(acc.channel_id);
    const t = today();
    const yesterday = shiftDay(t, -1);
    const same = state && state.ig_user_id === acc.ig_user_id;
    if (!same || !state.cursor_day || !state.floor_day) {
      const fresh = {
        ig_user_id: acc.ig_user_id,
        status: 'running',
        cursor_day: shiftDay(yesterday, -1),   // вчера — день крона
        floor_day: shiftDay(yesterday, -L.maxDays),
        horizon_day: null,
        empty_streak: 0,
        day_attempts: 0,
        days_fetched: 0,
        days_with_data: 0,
        calls_day: same ? state.calls_day : t,
        calls_count: same ? state.calls_count : 0,
        error: null,
        started_at: new Date(now()),
        finished_at: null,
      };
      await db.setIgBackfillState(acc.channel_id, fresh);
      if (!same) log('info', 'ig_backfill_started', { channelId: acc.channel_id, floorDay: fresh.floor_day });
      return { ...fresh };
    }
    if (state.status === 'error' || state.status === 'idle') {
      await db.setIgBackfillState(acc.channel_id, { status: 'running', error: null, day_attempts: 0 });
      return { ...state, status: 'running', error: null, day_attempts: 0 };
    }
    return { ...state };
  }

  const callsToday = (st) => (st.calls_day === today() ? Number(st.calls_count) || 0 : 0);

  // Один чанк догрузки одного аккаунта (под claim'ом). Идёт от cursor_day к более старым дням.
  async function walk(acc, token, st, stopReason) {
    const ch = acc.channel_id;
    const t = today();
    const followerCountFloor = shiftDay(t, -29);   // follower_count живёт ~30 дней
    const s = {
      cursor_day: st.cursor_day,
      horizon_day: st.horizon_day || null,
      empty_streak: Number(st.empty_streak) || 0,
      day_attempts: Number(st.day_attempts) || 0,
      days_fetched: Number(st.days_fetched) || 0,
      days_with_data: Number(st.days_with_data) || 0,
      calls_day: t,
      calls_count: callsToday(st),
    };
    const out = { fetched: 0, calls: 0, skipped: 0, stopped: null, done: false, progressed: false };
    const checkpoint = (extra = {}) => db.setIgBackfillState(ch, { ...s, ...extra });
    const isDone = () => s.cursor_day < st.floor_day || s.empty_streak >= L.emptyStreak;

    // Какие дни уже заняты — одним запросом на весь оставшийся хвост (дёшево: ≤ maxDays строк).
    const occupied = new Set();
    if (!isDone()) {
      const status = await db.listIgDayStatus(ch, st.floor_day, s.cursor_day);
      for (const r of status) if (r.occupied) occupied.add(r.day);
    }

    while (!isDone() && out.fetched < L.daysPerPass) {
      const day = s.cursor_day;
      if (occupied.has(day)) {
        // Уже есть данные — ноль вызовов; день с данными обнуляет серию пустых и сдвигает горизонт.
        s.horizon_day = minDay(s.horizon_day, day);
        s.empty_streak = 0;
        s.day_attempts = 0;
        s.cursor_day = shiftDay(day, -1);
        out.skipped++;
        out.progressed = true;
        continue;
      }
      if (out.fetched > 0) {
        const r = stopReason();
        if (r) { out.stopped = r; break; }
      }
      if (s.calls_count + CALLS_PER_DAY > L.dailyCalls) { out.stopped = 'daily_budget'; break; }
      let res;
      try {
        res = await collectIgDailyForDay(acc, token, day, {
          followerCount: day >= followerCountFloor, guardSource: true, write: false, logPrefix: 'ig_backfill',
        });
      } catch (e) {
        // Throttle: квота уже потрачена — учитываем оценкой и чекпойнтим ДО проброса (чанк failed,
        // курсор цел, следующий проход повторит этот же день).
        if (isIgThrottleError(e)) {
          s.calls_count += CALLS_PER_DAY;
          await checkpoint().catch(() => {});
        }
        throw e;
      }
      s.calls_count += res.calls;
      out.calls += res.calls;
      s.days_fetched++;
      out.fetched++;
      out.progressed = true;
      if (res.outcome === 'reauth') {
        await checkpoint({ status: 'error', error: 'ig_reauth' });
        log('warn', 'ig_backfill_reauth', { channelId: ch, day });
        out.stopped = 'reauth';
        return out;
      }
      if (res.outcome === 'transient') {
        s.day_attempts++;
        if (s.day_attempts < L.maxDayAttempts) {
          await checkpoint();
          out.stopped = 'transient';
          return out;
        }
        // Третья временная неудача подряд: берём что успели (если есть) и идём дальше — дыру
        // подберёт дневной ремонт, пока день в его окне.
        log('warn', 'ig_backfill_day_skipped', { channelId: ch, day, attempts: s.day_attempts });
        if (res.row && hasPositive(res.row)) await write(acc, res.row);
        s.day_attempts = 0;
        s.cursor_day = shiftDay(day, -1);
      } else if (res.outcome === 'data') {
        await write(acc, res.row);
        s.empty_streak = 0;
        s.day_attempts = 0;
        s.days_with_data++;
        s.horizon_day = minDay(s.horizon_day, day);
        s.cursor_day = shiftDay(day, -1);
      } else {
        // empty: ничего не пишем — дыра честнее выдуманного нуля.
        s.empty_streak++;
        s.day_attempts = 0;
        s.cursor_day = shiftDay(day, -1);
      }
      await checkpoint();
    }

    if (isDone()) {
      out.done = true;
      out.progressed = true;
      await checkpoint({ status: 'done', error: null, finished_at: new Date(now()) });
      log('info', 'ig_backfill_done', {
        channelId: ch, horizonDay: s.horizon_day, daysFetched: s.days_fetched, daysWithData: s.days_with_data,
      });
    } else if (out.skipped && !out.fetched) {
      await checkpoint();   // одни пропуски — фиксируем продвинувшийся курсор
    }
    return out;
  }

  function hasPositive(row) {
    return Object.keys(row).some((k) => k !== 'day' && k !== 'followers_total' && row[k] != null && row[k] > 0);
  }

  function write(acc, row) {
    const { followers_total: _level, ...clean } = row;   // уровень базы бэкфилл не пишет никогда
    return db.upsertIgDaily(acc.channel_id, [clean], undefined, { guardSource: true, igUserId: acc.ig_user_id });
  }

  // Шаг догрузки одного аккаунта: токен до claim'а → состояние → чанк под runJobOnce.
  async function runAccountSlice(acc, stopReason) {
    const token = await openToken(acc);
    if (!token) return { stopped: 'token_decrypt' };
    const st = await ensureState(acc);
    if (st.status === 'done') return { stopped: null, alreadyDone: true };
    // Ключ: канал, идентичность, эпоха прохода (started_at сброса — повторное подключение того же
    // аккаунта начинает НОВЫЙ проход и не упирается в succeeded-чанки прошлого), курсор и попытка.
    const epoch = new Date(st.started_at).getTime() || 0;
    const key = `${acc.channel_id}:${acc.ig_user_id}:${epoch}:${st.cursor_day}:a${Number(st.day_attempts) || 0}`;
    try {
      const r = await db.runJobOnce('ig_backfill_chunk', key, async () => {
        const out = await walk(acc, token, st, stopReason);
        if (!out.progressed) throw new BackfillPause(out.stopped || 'no_progress');
        return { fetched: out.fetched, skipped: out.skipped, calls: out.calls, stopped: out.stopped, done: out.done };
      });
      if (r.skipped) return { stopped: null, claimSkipped: true };
      return r.result;
    } catch (e) {
      if (e?.igBackfillPause) return { stopped: e.reason, paused: true };
      throw e;
    }
  }

  // Дневной ремонт + доливка лага для завершённого аккаунта (раз в UTC-сутки под durable-ключом).
  async function healAccount(acc, stopReason) {
    const t = today();
    const yesterday = shiftDay(t, -1);
    const healKey = `${acc.channel_id}:${acc.ig_user_id}:${t}`;
    // Уже вылечен сегодня — ни дешифровки, ни claim'а (проход бегунка идёт каждые 15 минут).
    const prior = await db.getJob('ig_daily_heal', healKey);
    if (prior && prior.status === 'succeeded') return { claimSkipped: true };
    const token = await openToken(acc);
    if (!token) return { stopped: 'token_decrypt' };
    const r = await db.runJobOnce('ig_daily_heal', healKey, async () => {
      const st = (await db.getIgBackfillState(acc.channel_id)) || {};
      let calls = callsToday(st);
      const out = { topup: 0, repaired: 0, calls: 0, stopped: null };
      const budgetOk = () => calls + CALLS_PER_DAY <= L.dailyCalls;
      const collect = async (day) => {
        const res = await collectIgDailyForDay(acc, token, day, {
          followerCount: day >= shiftDay(t, -29), guardSource: true, write: false, logPrefix: 'ig_backfill',
        });
        calls += res.calls;
        out.calls += res.calls;
        return res;
      };
      const reauth = async () => {
        out.stopped = 'reauth';
        await db.setIgBackfillState(acc.channel_id, { status: 'error', error: 'ig_reauth' });
        log('warn', 'ig_backfill_reauth', { channelId: acc.channel_id, phase: 'heal' });
        return out;
      };
      try {
        // (а) доливка лага: вчера−1 … вчера−topupDays — перезапись финализированными значениями.
        const topup = [];
        for (let i = 1; i <= L.topupDays; i++) topup.push(shiftDay(yesterday, -i));
        for (const day of topup) {
          const stop = stopReason();
          if (stop) { out.stopped = stop; return out; }
          if (!budgetOk()) { out.stopped = 'daily_budget'; return out; }
          const res = await collect(day);
          if (res.outcome === 'reauth') return reauth();
          if (res.outcome === 'data') { await write(acc, res.row); out.topup++; }
        }
        // (б) ремонт: дыры (нет строки / строка без данных) и неполные дни (ни reach, ни views) в
        // [max(horizon, вчера−healWindowDays), вчера−1], свежие первыми, не больше healMaxDays.
        const windowStart = shiftDay(yesterday, -L.healWindowDays);
        const from = st.horizon_day && st.horizon_day > windowStart ? st.horizon_day : windowStart;
        const to = shiftDay(yesterday, -1);
        const byDay = new Map((await db.listIgDayStatus(acc.channel_id, from, to)).map((r) => [r.day, r]));
        const toppedUp = new Set(topup);
        const gaps = [];
        for (let day = to; day >= from && gaps.length < L.healMaxDays; day = shiftDay(day, -1)) {
          if (toppedUp.has(day)) continue;
          const row = byDay.get(day);
          if (!row?.occupied || row.incomplete) gaps.push(day);
        }
        for (const day of gaps) {
          const stop = stopReason();
          if (stop) { out.stopped = stop; return out; }
          if (!budgetOk()) { out.stopped = 'daily_budget'; return out; }
          // Memo дня: честно пустой день не перезапрашивается каждые сутки (строка jobs живёт до
          // ретеншна ~30 дней); временный сбой и умерший токен бросают — день останется повторяемым.
          let memo;
          try {
            memo = await db.runJobOnce('ig_day_repair', `${acc.channel_id}:${acc.ig_user_id}:${day}`, async () => {
              const res = await collect(day);
              if (res.outcome === 'reauth' || res.outcome === 'transient') {
                const e = new Error(`ig_day_repair_${res.outcome}`);
                e.repairOutcome = res.outcome;
                throw e;
              }
              if (res.outcome === 'data') { await write(acc, res.row); return { repaired: true }; }
              return { repaired: false };
            });
          } catch (e) {
            if (isIgThrottleError(e)) throw e;
            if (e && e.repairOutcome === 'reauth') return reauth();
            log('warn', 'ig_backfill_repair_failed', { channelId: acc.channel_id, day, error: e.message });
            continue;
          }
          if (memo?.result?.repaired) out.repaired++;
        }
        return out;
      } finally {
        await db.setIgBackfillState(acc.channel_id, { calls_day: t, calls_count: calls }).catch(() => {});
      }
    });
    return r.skipped ? { claimSkipped: true } : r.result;
  }

  // Проход recovery-бегунка: шаги догрузки для до accountsPerPass аккаунтов, затем дневной ремонт
  // завершённых. Возвращает статистику для лога прохода (collection_recovery_pass_done.igBackfill).
  async function runIgBackfillPass() {
    const stats = { accounts: 0, fetched: 0, skipped: 0, calls: 0, done: 0, healed: 0, failed: 0, stopped: null };
    if (!db.enabled || !igCrypto?.configured() || !L.enabled) return { ...stats, disabled: true };
    const stopReason = makeStopper(now());
    const initial = stopReason();
    if (initial) return { ...stats, stopped: initial };
    const walked = new Set();   // аккаунты, которые этот проход уже вёл: ремонт им — со следующих суток
    let candidates = [];
    try { candidates = await db.listIgBackfillCandidates(L.accountsPerPass); }
    catch (e) { log('error', 'ig_backfill_list_failed', { error: e.message }); return { ...stats, failed: 1 }; }
    for (const acc of candidates) {
      const stop = stopReason();
      if (stop) { stats.stopped = stop; break; }
      walked.add(acc.channel_id);
      try {
        const r = await runAccountSlice(acc, stopReason);
        stats.accounts++;
        if (r) {
          stats.fetched += r.fetched || 0;
          stats.skipped += r.skipped || 0;
          stats.calls += r.calls || 0;
          if (r.done) stats.done++;
          if (PASS_STOPS.has(r.stopped)) { stats.stopped = r.stopped; break; }
        }
      } catch (e) {
        stats.failed++;
        log('warn', 'ig_backfill_account_failed', { channelId: acc.channel_id, error: e.message, throttle: isIgThrottleError(e) });
        if (isIgThrottleError(e)) { stats.stopped = 'throttle'; return stats; }
      }
    }
    if (stats.stopped) return stats;
    let heal = [];
    try { heal = await db.listIgHealCandidates(L.healAccountsPerPass); }
    catch (e) { log('error', 'ig_backfill_heal_list_failed', { error: e.message }); return stats; }
    for (const acc of heal) {
      if (walked.has(acc.channel_id)) continue;
      const stop = stopReason();
      if (stop) { stats.stopped = stop; break; }
      try {
        const r = await healAccount(acc, stopReason);
        if (r && !r.claimSkipped && r.stopped !== 'token_decrypt') { stats.healed++; stats.calls += r.calls || 0; }
        if (r && PASS_STOPS.has(r.stopped)) { stats.stopped = r.stopped; break; }
      } catch (e) {
        stats.failed++;
        log('warn', 'ig_backfill_heal_failed', { channelId: acc.channel_id, error: e.message, throttle: isIgThrottleError(e) });
        if (isIgThrottleError(e)) { stats.stopped = 'throttle'; break; }
      }
    }
    return stats;
  }

  // Один шаг для только что подключённого/переподключённого канала (OAuth callback, runDetached):
  // история начинает догружаться сразу, а не с ближайшего прохода бегунка. Делит ключи claim'а с
  // проходом, поэтому гонка web-kick ↔ worker-проход безопасна.
  async function kickIgBackfill(channelId) {
    if (!db.enabled || !igCrypto?.configured() || !L.enabled || !channelId) return { skipped: true };
    const stopReason = makeStopper(now());
    const initial = stopReason();
    if (initial) return { stopped: initial };
    const acc = await db.getIgAccount(channelId);
    if (!acc?.access_token_enc) return { skipped: true };
    const st = await db.getIgBackfillState(channelId);
    if (st && st.ig_user_id === acc.ig_user_id && st.status === 'done') {
      return { ...(await healAccount(acc, stopReason)), kicked: 'heal' };
    }
    return { ...(await runAccountSlice(acc, stopReason)), kicked: 'walk' };
  }

  return { runIgBackfillPass, kickIgBackfill };
}

module.exports = { createIgBackfillJob, CALLS_PER_DAY, DEFAULT_LIMITS };
