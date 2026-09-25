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
//     чужие строки. followers_total бэкфилл не шлёт — якорь уровня от крона сохраняется. День ЧУЖОЙ
//     идентичности — не история текущего аккаунта: он только пропускается, горизонт и серию пустых
//     не трогает (клиент узнаёт о скрытых днях из coverage.hidden_days).
//   • Пропуск ≠ ноль: пустой день (Graph не отдал ни одного значения) НЕ пишется — в архиве
//     остаётся честная дыра; честные нули Graph пишутся, как у крона. 7 пустых дней подряд =
//     горизонт Graph (horizon_day), дальше не ходим; глубже maxDays (730) не пробуем вовсе. Это
//     граница опроса, а не потолок чтения. Отказ в правах (#10/#200) — не пустой день, а состояние
//     аккаунта: error ig_permission, курсор стоит, серия пустых не растёт.
//   • Квота прежде всего: проход идёт ПОСЛЕ дневного крона в той же IG-полосе через paced-клиент
//     (общий singleflight и usage-gate). Весь проход останавливается на открытом gate, на BUC ≥
//     bucStopPct, на исчерпанном времени прохода; аккаунт — на дневном бюджете вызовов. Throttle
//     (429, в т.ч. Graph 80002) — чекпойнт и проброс: чанк-джоба failed и повторяема.
//   • Возобновляемость: чекпойнт после каждого сходившего в Graph дня (cursor_day и счётчики в
//     ig_backfill_state) — рестарт повторяет максимум один день, а повтор безопасен (COALESCE).
//     Чанк клеймится runJobOnce('ig_backfill_chunk', ch:ig_user:эпоха:cursor_day:aN): 15-минутный lease
//     разводит web-kick и worker-проход, чанк без продвижения бросает паузу и остаётся повторяемым.
//     Каждый чекпойнт условен (ig_user_id + эпоха started_at, с которыми чанк начат): чанк прежнего
//     аккаунта, доживающий после переподключения другого, не затирает состояние нового и обрывается.
//   • done без единого дня с данными (горизонт не найден) — не приговор: переподключение или продление
//     токена (ig_accounts.updated_at > finished_at) начинает проход заново.
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

// Throttle ОДНОГО аккаунта (Graph 17 — user, 32 — page, 80002 — BUC аккаунта), а не приложения:
// проход пропускает этот аккаунт и идёт к следующему. App-уровень (4/613, открытый gate) и throttle
// без кода по-прежнему останавливают весь проход.
const ACCOUNT_THROTTLE_CODES = new Set([17, 32, 80002]);
function isAccountThrottle(e) {
  return isIgThrottleError(e) && !e.igGateStopped && ACCOUNT_THROTTLE_CODES.has(Number(e.igCode));
}
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

  // done, не нашедший ни одного дня с данными: горизонта нет, это сбой обхода, а не край истории.
  const doneWithoutData = (st) => st?.status === 'done' && (!st.horizon_day || !(Number(st.days_with_data) > 0));

  // Состояние для текущей идентичности: сброс, если его нет, другая идентичность, проход ещё не
  // инициализирован или (reconnected) done той же идентичности без единого дня с данными; error той
  // же идентичности (повтор через сутки / после reconnect) — снова running.
  async function ensureState(acc, { reconnected = false } = {}) {
    const state = await db.getIgBackfillState(acc.channel_id);
    const t = today();
    const yesterday = shiftDay(t, -1);
    const same = state && state.ig_user_id === acc.ig_user_id;
    const restart = same && reconnected && doneWithoutData(state);
    if (!same || !state.cursor_day || !state.floor_day || restart) {
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
      if (!same || restart) {
        log('info', 'ig_backfill_started', { channelId: acc.channel_id, floorDay: fresh.floor_day, restart });
      }
      return { ...fresh };
    }
    if (state.status === 'error' || state.status === 'idle') {
      const ok = await db.setIgBackfillState(acc.channel_id, { status: 'running', error: null, day_attempts: 0 }, expectOf(state));
      if (!ok) throw new BackfillPause('identity_changed');
      return { ...state, status: 'running', error: null, day_attempts: 0 };
    }
    return { ...state };
  }

  const callsToday = (st) => (st.calls_day === today() ? Number(st.calls_count) || 0 : 0);
  // Условие чекпойнта: та же идентичность и та же эпоха прохода, что у прочитанного состояния.
  const expectOf = (st) => ({ ig_user_id: st.ig_user_id, started_at: st.started_at ?? null });

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
    const out = { fetched: 0, calls: 0, skipped: 0, blocked: 0, stopped: null, done: false, progressed: false };
    const expect = expectOf({ ig_user_id: acc.ig_user_id, started_at: st.started_at });
    // Чекпойнт условен: строку за это время переписал проход другой идентичности (переподключение
    // посреди чанка) — чанк обрывается, чужое состояние не трогаем.
    const checkpoint = async (extra = {}) => {
      const ok = await db.setIgBackfillState(ch, { ...s, ...extra }, expect);
      if (!ok) {
        log('warn', 'ig_backfill_identity_changed', { channelId: ch, igUserId: acc.ig_user_id });
        throw new BackfillPause('identity_changed');
      }
    };
    const isDone = () => s.cursor_day < st.floor_day || s.empty_streak >= L.emptyStreak;

    // Какие дни уже заняты — одним запросом на весь оставшийся хвост (дёшево: ≤ maxDays строк).
    const occupied = new Set();
    const foreign = new Set();
    if (!isDone()) {
      const status = await db.listIgDayStatus(ch, st.floor_day, s.cursor_day);
      for (const r of status) {
        if (r.is_foreign) foreign.add(r.day);
        else if (r.occupied) occupied.add(r.day);
      }
    }

    while (!isDone() && out.fetched < L.daysPerPass) {
      const day = s.cursor_day;
      if (foreign.has(day)) {
        // День прежнего аккаунта: вызовы на него бессмысленны (guardSource не перезапишет), а историей
        // ТЕКУЩЕГО аккаунта он не является — горизонт по нему не двигаем, серию пустых не сбрасываем.
        s.day_attempts = 0;
        s.cursor_day = shiftDay(day, -1);
        out.blocked++;
        out.progressed = true;
        continue;
      }
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
      if (res.outcome === 'denied') {
        // Нет прав на статистику: не горизонт и не пустой день. Курсор стоит, серия пустых не растёт;
        // error ig_permission вернёт аккаунт в кандидаты через сутки или после переподключения.
        await checkpoint({ status: 'error', error: 'ig_permission' });
        log('warn', 'ig_backfill_permission_denied', { channelId: ch, day });
        out.stopped = 'denied';
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
        if (res.row && hasValue(res.row)) await write(acc, res.row);
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
        // empty (Graph не отдал ни одного значения): ничего не пишем — дыра честнее выдуманного нуля.
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
    } else if ((out.skipped || out.blocked) && !out.fetched) {
      await checkpoint();   // одни пропуски — фиксируем продвинувшийся курсор
    }
    if (out.blocked) log('info', 'ig_backfill_foreign_days_skipped', { channelId: ch, days: out.blocked });
    return out;
  }

  // Строка несёт хоть одно значение (честный ноль — тоже значение; followers_total бэкфилл не пишет).
  function hasValue(row) {
    return Object.keys(row).some((k) => k !== 'day' && k !== 'followers_total' && row[k] != null);
  }

  function write(acc, row) {
    const { followers_total: _level, ...clean } = row;   // уровень базы бэкфилл не пишет никогда
    return db.upsertIgDaily(acc.channel_id, [clean], undefined, { guardSource: true, igUserId: acc.ig_user_id });
  }

  // Шаг догрузки одного аккаунта: токен до claim'а → состояние → чанк под runJobOnce.
  async function runAccountSlice(acc, stopReason, { reconnected = false } = {}) {
    const token = await openToken(acc);
    if (!token) return { stopped: 'token_decrypt' };
    let st;
    try {
      st = await ensureState(acc, { reconnected });
    } catch (e) {
      if (e?.igBackfillPause) return { stopped: e.reason, paused: true };
      throw e;
    }
    if (st.status === 'done') return { stopped: null, alreadyDone: true };
    // Ключ: канал, идентичность, эпоха прохода (started_at сброса — повторное подключение того же
    // аккаунта начинает НОВЫЙ проход и не упирается в succeeded-чанки прошлого), курсор и попытка.
    const epoch = new Date(st.started_at).getTime() || 0;
    const key = `${acc.channel_id}:${acc.ig_user_id}:${epoch}:${st.cursor_day}:a${Number(st.day_attempts) || 0}`;
    try {
      const r = await db.runJobOnce('ig_backfill_chunk', key, async () => {
        const out = await walk(acc, token, st, stopReason);
        // Чанк без продвижения и чанк, упёршийся в умерший токен или отказ в правах, остаются
        // повторяемыми (failed): иначе после переподключения тот же ключ (тот же cursor_day) числился
        // бы выполненным и догрузка стояла бы до ретеншна jobs.
        if (!out.progressed || out.stopped === 'reauth' || out.stopped === 'denied') {
          throw new BackfillPause(out.stopped || 'no_progress');
        }
        return {
          fetched: out.fetched, skipped: out.skipped, blocked: out.blocked, calls: out.calls, stopped: out.stopped, done: out.done,
        };
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
    const heal = async () => {
      const st = (await db.getIgBackfillState(acc.channel_id)) || {};
      // Все записи состояния из ремонта — условные: за время ремонта канал могли переподключить.
      const expect = expectOf({ ig_user_id: acc.ig_user_id, started_at: st.started_at });
      let calls = callsToday(st);
      const out = { topup: 0, repaired: 0, calls: 0, stopped: null };
      // Ремонт, остановленный раньше конца (стоп прохода, дневной бюджет), бросает паузу: durable-ключ
      // дня остаётся failed и следующий проход доделает доливку/ремонт, а не сочтёт день вылеченным.
      const pause = (reason) => {
        const e = new BackfillPause(reason);
        e.healOut = { ...out, stopped: reason };
        throw e;
      };
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
        await db.setIgBackfillState(acc.channel_id, { status: 'error', error: 'ig_reauth' }, expect);
        log('warn', 'ig_backfill_reauth', { channelId: acc.channel_id, phase: 'heal' });
        return out;
      };
      const denied = async () => {
        out.stopped = 'denied';
        await db.setIgBackfillState(acc.channel_id, { status: 'error', error: 'ig_permission' }, expect);
        log('warn', 'ig_backfill_permission_denied', { channelId: acc.channel_id, phase: 'heal' });
        return out;
      };
      try {
        // (а) доливка лага: вчера−1 … вчера−topupDays — перезапись финализированными значениями.
        const topup = [];
        for (let i = 1; i <= L.topupDays; i++) topup.push(shiftDay(yesterday, -i));
        for (const day of topup) {
          const stop = stopReason();
          if (stop) pause(stop);
          if (!budgetOk()) pause('daily_budget');
          const res = await collect(day);
          if (res.outcome === 'reauth') return reauth();
          if (res.outcome === 'denied') return denied();
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
          if (stop) pause(stop);
          if (!budgetOk()) pause('daily_budget');
          // Memo дня: честно пустой день не перезапрашивается каждые сутки (строка jobs живёт до
          // ретеншна ~30 дней); временный сбой, умерший токен и отказ в правах бросают — день останется
          // повторяемым (отказ в правах — не «честно пустой» день).
          let memo;
          try {
            memo = await db.runJobOnce('ig_day_repair', `${acc.channel_id}:${acc.ig_user_id}:${day}`, async () => {
              const res = await collect(day);
              if (res.outcome === 'reauth' || res.outcome === 'transient' || res.outcome === 'denied') {
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
            if (e?.repairOutcome === 'denied') return denied();
            log('warn', 'ig_backfill_repair_failed', { channelId: acc.channel_id, day, error: e.message });
            continue;
          }
          if (memo?.result?.repaired) out.repaired++;
        }
        return out;
      } finally {
        await db.setIgBackfillState(acc.channel_id, { calls_day: t, calls_count: calls }, expect).catch(() => {});
      }
    };
    let r;
    try {
      r = await db.runJobOnce('ig_daily_heal', healKey, heal);
    } catch (e) {
      if (e?.igBackfillPause) return { ...(e.healOut || {}), stopped: e.reason, paused: true };
      throw e;
    }
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
    // Аккаунты, выбравшие дневной бюджет, в кандидаты не попадают: иначе они, не двигая свой
    // updated_at, занимали бы все accountsPerPass слотов до UTC-полуночи.
    try { candidates = await db.listIgBackfillCandidates(L.accountsPerPass, { day: today(), maxCalls: L.dailyCalls - CALLS_PER_DAY }); }
    catch (e) { log('error', 'ig_backfill_list_failed', { error: e.message }); return { ...stats, failed: 1 }; }
    for (const acc of candidates) {
      const stop = stopReason();
      if (stop) { stats.stopped = stop; break; }
      walked.add(acc.channel_id);
      try {
        const r = await runAccountSlice(acc, stopReason, { reconnected: acc.restart_done === true });
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
        // Throttle одного аккаунта — к следующему; throttle приложения — стоп всего прохода.
        if (isIgThrottleError(e) && !isAccountThrottle(e)) { stats.stopped = 'throttle'; return stats; }
      }
    }
    if (stats.stopped) return stats;
    let heal = [];
    try { heal = await db.listIgHealCandidates(L.healAccountsPerPass, today()); }
    catch (e) { log('error', 'ig_backfill_heal_list_failed', { error: e.message }); return stats; }
    for (const acc of heal) {
      if (walked.has(acc.channel_id)) continue;
      const stop = stopReason();
      if (stop) { stats.stopped = stop; break; }
      try {
        const r = await healAccount(acc, stopReason);
        if (r) stats.calls += r.calls || 0;
        if (r && !r.claimSkipped && !r.paused && r.stopped !== 'token_decrypt') stats.healed++;
        if (r && PASS_STOPS.has(r.stopped)) { stats.stopped = r.stopped; break; }
      } catch (e) {
        stats.failed++;
        log('warn', 'ig_backfill_heal_failed', { channelId: acc.channel_id, error: e.message, throttle: isIgThrottleError(e) });
        // Throttle одного аккаунта (80002 и т.п.) — пропускаем его и лечим остальных; его ключ дня
        // остаётся failed, и список кандидатов ставит его в конец.
        if (isIgThrottleError(e) && !isAccountThrottle(e)) { stats.stopped = 'throttle'; break; }
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
    // Kick зовёт OAuth-колбэк — это и есть переподключение: done БЕЗ данных начинается заново,
    // done с найденным горизонтом получает только дневной ремонт.
    if (st && st.ig_user_id === acc.ig_user_id && st.status === 'done' && !doneWithoutData(st)) {
      return { ...(await healAccount(acc, stopReason)), kicked: 'heal' };
    }
    return { ...(await runAccountSlice(acc, stopReason, { reconnected: true })), kicked: 'walk' };
  }

  return { runIgBackfillPass, kickIgBackfill };
}

module.exports = { createIgBackfillJob, CALLS_PER_DAY, DEFAULT_LIMITS, isAccountThrottle };
