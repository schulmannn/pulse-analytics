// ═══════════════════════════════════════════════════════════════
//  Atlavue — чанковый бэкфилл заказов покупателей МойСклада (engine)
// ═══════════════════════════════════════════════════════════════
// Дневной архив (msCollectionJob) видит только агрегаты plotseries; этот движок один раз
// протягивает в ms_orders ВСЮ историю заказов аккаунта помесячными окнами, с живым прогрессом
// в ms_backfill_state и restart-resume. Запускается кнопкой (POST /api/ms/backfill →
// fire-and-forget) на единственной web-реплике — in-process single-flight легален и дополняется
// durable-свежестью строки состояния (переживает рестарт).
//
// Ключевые решения:
//   • Чанк = календарный месяц: окно [cursor_from … конец месяца], страницы по 1000 (limit МС
//     без expand), order=moment,asc. cursor_from продвигается в БД ПОСЛЕ полного месяца —
//     resume после рестарта повторяет максимум один месяц, а upsert идемпотентен (замена).
//   • Прогресс живой: после КАЖДОЙ страницы setMsBackfillState({fetched_count, cursor_from}) —
//     это и счётчик для UI, и heartbeat (updated_at=now()), по которому отличаем живой прогон
//     (свежее MS_BACKFILL_FRESH_RUNNING_SECONDS → отказ «уже идёт») от брошенного (старше
//     MS_BACKFILL_STALE_RESUME_SECONDS → resume() в recovery-бегунке продолжает с cursor_from).
//   • Пауза ~150мс между страницами щадит лимит МС (45 запросов/3с, per-account); одиночный
//     429 добирает ретрай внутри msFetch.
//   • fetched_count может разойтись с total_estimate (заказы создавали/удаляли во время
//     прогона, resume пере-снимает месяц) — это оценка для прогресс-бара, не инвариант.
//   • Фатальная ошибка → {status:'error', error} С СОХРАНЕНИЕМ cursor_from: повторный старт
//     нажатием кнопки начнёт заново, а вот resume() ошибочные строки сознательно НЕ трогает.
//   • Доливка (runTopupPass): каналам со status='done' раз в день (durable-гейт
//     'ms_orders_topup', ключ с ms_account_id — reconnect другого склада не наследует
//     succeeded, урок ms_collect) пере-снимаются последние 7 дней тем же page-циклом, статус
//     бэкфилла НЕ меняется.
//   • Токен дешифруется только здесь и живёт в заголовке запроса (msFetch); в state/логи не
//     попадает по построению. Дешифровка — ДО claim'а дня в topup (битый ключ не сжигает день).

'use strict';

const MS_BACKFILL_FRESH_RUNNING_SECONDS = 5 * 60;   // моложе → «уже идёт» (отказ старта)
const MS_BACKFILL_STALE_RESUME_SECONDS = 10 * 60;   // старше → брошенный прогон (resume)
const MS_ORDERS_PAGE_LIMIT = 1000;                  // максимум МС без expand
const MS_ORDERS_PAGE_PAUSE_MS = 150;
const MS_ORDERS_TOPUP_WINDOW_DAYS = 7;

function createMsBackfillEngine({ db, msFetch, msCrypto, log = () => {}, sleepFn } = {}) {
  const sleep = sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // In-process single-flight по каналу. Set пополняется СИНХРОННО в start() (до первого await),
  // поэтому гонка двух одновременных POST в одном процессе исключена без блокировок.
  const inFlight = new Set();

  // 'YYYY-MM-DD' по местным часам процесса (Railway = UTC) — та же система координат, что у
  // periodWindow живых роутов и окна msCollectionJob: границы окон и cursor_from не расходятся.
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseDay = (s) => {
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
  const monthEnd = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const nextMonthStart = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 1);

  const shortMsg = (e) => String((e && e.message) || e || 'unknown').slice(0, 500);
  // NaN-сравнения дают false → отсутствующий/кривой возраст трактуется консервативно:
  // не-fresh для отказа старта и не-stale для resume.
  const ageSeconds = (state) => Number(state && state.updated_age_seconds);
  const isFreshRunning = (state) =>
    !!state && state.status === 'running' && ageSeconds(state) < MS_BACKFILL_FRESH_RUNNING_SECONDS;

  // Строка МС customerorder → строка ms_orders. Null-safe: без expand agent/state приходят
  // meta-only ссылками (name отсутствует) — тогда NULL, не падение. moment валидируем строго
  // (тот же урок, что dayOf в msCollectionJob): одна кривая строка иначе уронила бы
  // timestamptz-каст ВСЕГО jsonb-батча в upsertMsOrders.
  // id сущности = последний сегмент href meta-ссылки (…/entity/counterparty/<uuid>,
  // …/metadata/states/<uuid>); query-хвост отрезаем, пустые сегменты не считаются.
  const metaHrefId = (link) => {
    const href = link && link.meta && typeof link.meta.href === 'string' ? link.meta.href : '';
    return href ? href.split('?')[0].split('/').filter(Boolean).pop() || null : null;
  };
  function orderToRow(o) {
    if (!o || o.id == null) return null;
    const moment = typeof o.moment === 'string' ? o.moment : '';
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(moment)) return null;
    return {
      order_id: String(o.id),
      moment,
      // Копейки как есть; Math.round — страховка от неожиданной дробной копейки, не конверсия.
      sum_kopecks: Math.round(Number(o.sum) || 0),
      state: o.state && typeof o.state.name === 'string' ? o.state.name : null,
      // Имя статуса без expand пусто (см. выше) — храним устойчивый id (миграция 030), имя/цвет
      // добавляет словарь metadata/states на границе API (/api/ms/funnel).
      state_id: metaHrefId(o.state),
      // Канал продаж без expand — тоже meta-only ссылка …/entity/saleschannel/<uuid>; храним
      // устойчивый id (миграция 031), имя/тип добавляет словарь saleschannel на границе API
      // (/api/ms/sales-by-channel).
      sales_channel_id: metaHrefId(o.salesChannel),
      // Город доставки — ВЛОЖЕННЫЙ объект shipmentAddressFull (не ссылка), берём .city как есть
      // (trim, пусто→null); нормализацию префикса «г »→«Москва» делает SQL-агрегат geography, не
      // движок. ~50% заказов без адреса (самовывоз) → null.
      city: o.shipmentAddressFull && typeof o.shipmentAddressFull.city === 'string'
        ? (o.shipmentAddressFull.city.trim() || null) : null,
      agent_id: metaHrefId(o.agent),
      agent_name: o.agent && typeof o.agent.name === 'string' ? o.agent.name : null,
    };
  }

  // Страничный цикл одного окна [fromDay … toDay] (границы дней включительно). После каждой
  // страницы отдаёт УЖЕ смапленные строки в onPage (там upsert + прогресс); между страницами —
  // пауза. Фильтр URL-encode'ится целиком: пробелы/>=/; в query иначе ломают запрос.
  async function fetchWindowPages(token, fromDay, toDay, onPage) {
    const filter = `moment>=${fromDay} 00:00:00;moment<=${toDay} 23:59:59`;
    let offset = 0;
    for (;;) {
      const path = `/entity/customerorder?filter=${encodeURIComponent(filter)}` +
        `&order=${encodeURIComponent('moment,asc')}&limit=${MS_ORDERS_PAGE_LIMIT}&offset=${offset}`;
      const page = await msFetch(token, path);
      const raw = page && Array.isArray(page.rows) ? page.rows : [];
      await onPage(raw.map(orderToRow).filter(Boolean));
      if (raw.length < MS_ORDERS_PAGE_LIMIT) return;
      offset += MS_ORDERS_PAGE_LIMIT;
      await sleep(MS_ORDERS_PAGE_PAUSE_MS);
    }
  }

  // Resume-able цикл: помесячно от cursorFromDay до текущего месяца включительно. cursor_from в
  // БД продвигается на следующий месяц только ПОСЛЕ полного месяца — рестарт повторит максимум
  // один месяц (upsert-замена делает повтор безопасным). Фатальный сбой пишет status='error'
  // С СОХРАНЕНИЕМ cursor_from и fetched_count (resume/повторный разбор с места) и re-throw'ит.
  async function runWindowLoop(channelId, token, cursorFromDay, fetchedStart) {
    let fetched = fetchedStart;
    try {
      let cursor = parseDay(cursorFromDay);
      const lastMonth = monthStart(new Date());
      while (monthStart(cursor) <= lastMonth) {
        const winFrom = fmtDay(cursor);
        const winTo = fmtDay(monthEnd(cursor));
        await fetchWindowPages(token, winFrom, winTo, async (rows) => {
          if (rows.length) await db.upsertMsOrders(channelId, rows);
          fetched += rows.length;
          // Прогресс + heartbeat после КАЖДОЙ страницы (пустой месяц тоже штампует updated_at).
          await db.setMsBackfillState(channelId, {
            status: 'running', cursor_from: winFrom, fetched_count: fetched,
          });
        });
        cursor = nextMonthStart(cursor);
        await db.setMsBackfillState(channelId, {
          status: 'running', cursor_from: fmtDay(cursor), fetched_count: fetched,
        });
      }
      await db.setMsBackfillState(channelId, { status: 'done', fetched_count: fetched, error: null });
      return { status: 'done', fetched };
    } catch (e) {
      await db.setMsBackfillState(channelId, { status: 'error', error: shortMsg(e) }).catch(() => {});
      throw e;
    }
  }

  // Полный прогон одного канала: single-flight по durable-свежести → оценка → старейший заказ →
  // claim 'running' → помесячный цикл. Отказ и pre-claim сбои (нет учётки/битый ключ) state НЕ
  // трогают; сбой оценки уже честно пишется как error (кнопка нажата — UI должен видеть исход).
  async function runBackfill(channelId) {
    const prior = await db.getMsBackfillState(channelId);
    if (isFreshRunning(prior)) {
      const err = new Error('Загрузка уже идёт');
      err.code = 'MS_BACKFILL_RUNNING';
      throw err;
    }
    const acc = await db.getMsAccount(channelId);
    if (!acc || !acc.access_token_enc) throw new Error('МойСклад не подключён к этому каналу');
    const token = msCrypto.decrypt(acc.access_token_enc);
    let cursorFrom;
    try {
      // Оценка объёма: meta.size полной выборки заказов (для прогресс-бара, не инвариант).
      const head = await msFetch(token, `/entity/customerorder?limit=1`);
      const size = Number(head && head.meta && head.meta.size);
      const totalEstimate = Number.isFinite(size) ? size : null;
      // Старейший заказ задаёт горизонт: бэкфилл стартует с ПЕРВОГО ЧИСЛА его месяца.
      const oldest = await msFetch(token, `/entity/customerorder?limit=1&order=${encodeURIComponent('moment,asc')}`);
      const first = oldest && Array.isArray(oldest.rows) && oldest.rows[0];
      const firstMoment = first && typeof first.moment === 'string' ? first.moment.slice(0, 10) : '';
      if (totalEstimate === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(firstMoment)) {
        // Пустой аккаунт (или МС не отдал ни одного moment) — честный done сразу, без цикла.
        await db.setMsBackfillState(channelId, {
          status: 'done', cursor_from: null, total_estimate: totalEstimate ?? 0,
          fetched_count: 0, error: null, started_at: new Date(),
        });
        return { status: 'done', fetched: 0 };
      }
      cursorFrom = fmtDay(monthStart(parseDay(firstMoment)));
      await db.setMsBackfillState(channelId, {
        status: 'running', cursor_from: cursorFrom, total_estimate: totalEstimate,
        fetched_count: 0, error: null, started_at: new Date(),
      });
    } catch (e) {
      await db.setMsBackfillState(channelId, { status: 'error', error: shortMsg(e) }).catch(() => {});
      throw e;
    }
    return runWindowLoop(channelId, token, cursorFrom, 0);
  }

  // Публичный старт (роут зовёт fire-and-forget). НЕ async: inFlight-гейт срабатывает
  // синхронно, до первого await — второй start того же канала в этом процессе отсекается
  // ещё до чтения БД.
  function start(channelId) {
    const id = Number(channelId) || 0;
    if (!id) return Promise.reject(new Error('channelId обязателен'));
    if (!db.enabled) return Promise.reject(new Error('База данных недоступна'));
    if (!msCrypto.configured()) return Promise.reject(new Error('MS_TOKEN_KEY не задан'));
    if (inFlight.has(id)) {
      const err = new Error('Загрузка уже идёт');
      err.code = 'MS_BACKFILL_RUNNING';
      return Promise.reject(err);
    }
    inFlight.add(id);
    return runBackfill(id).finally(() => inFlight.delete(id));
  }

  // Проверка для роута (409 «Загрузка уже идёт»): живой прогон этого процесса ИЛИ durable-свежая
  // running-строка (короткое окно после краша — консервативно ждём resume, а не второй прогон).
  async function isBusy(channelId) {
    const id = Number(channelId) || 0;
    if (!id) return false;
    if (inFlight.has(id)) return true;
    const state = await db.getMsBackfillState(id).catch(() => null);
    return isFreshRunning(state);
  }

  // Resume зависших бэкфиллов (рестарт процесса убил прогон): running-строки старше
  // MS_BACKFILL_STALE_RESUME_SECONDS продолжают цикл с сохранённого cursor_from, наращивая
  // fetched_count. Кандидаты — по listMsAccounts (без учётки продолжать нечем: нужен токен);
  // status='error' сознательно НЕ трогаем — это исход для человека и кнопки, не для крона.
  async function resume() {
    const stats = { resumed: 0, errors: 0 };
    if (!db.enabled || !msCrypto.configured()) return stats;
    let accounts = [];
    try { accounts = await db.listMsAccounts(); }
    catch (e) { log('error', 'ms_backfill_list_failed', { error: e.message }); return stats; }
    for (const acc of accounts) {
      const channelId = acc.channel_id;
      if (inFlight.has(channelId)) continue;   // живой прогон этого процесса — не дублируем
      const state = await db.getMsBackfillState(channelId).catch(() => null);
      if (!state || state.status !== 'running') continue;
      if (!(ageSeconds(state) >= MS_BACKFILL_STALE_RESUME_SECONDS)) continue;
      if (!state.cursor_from) {
        // running без курсора по построению не бывает (claim пишет их вместе) — честный error
        // вместо вечного зомби, который resume гонял бы каждый проход.
        await db.setMsBackfillState(channelId, { status: 'error', error: 'resume: нет курсора' }).catch(() => {});
        stats.errors++;
        continue;
      }
      let token;
      try {
        token = msCrypto.decrypt(acc.access_token_enc);
      } catch (e) {
        // Битый ключ/блоб: строка остаётся running-stale (после починки ключа resume добёрет);
        // ни ciphertext, ни plaintext в лог не попадают.
        log('warn', 'ms_token_decrypt_failed', { channelId, error: e.message });
        stats.errors++;
        continue;
      }
      inFlight.add(channelId);
      try {
        await runWindowLoop(channelId, token, state.cursor_from, Number(state.fetched_count) || 0);
        stats.resumed++;
        log('info', 'ms_backfill_resumed', { channelId });
      } catch (e) {
        stats.errors++;   // state уже 'error' с сохранённым cursor (runWindowLoop записал)
        log('error', 'ms_backfill_resume_failed', { channelId, error: e.message });
      } finally {
        inFlight.delete(channelId);
      }
    }
    return stats;
  }

  // Дневная доливка свежих заказов каналам с завершённым бэкфиллом: окно последних 7 дней тем же
  // page-циклом, БЕЗ изменения status/прогресса бэкфилла. Durable day-gate 'ms_orders_topup'
  // (образец ms_collect) — реальная работа раз в день, сбой дня добирает следующий проход.
  async function runTopupPass() {
    const stats = { channels: 0, orders: 0, errors: 0, skipped: 0 };
    if (!db.enabled || !msCrypto.configured()) return stats;
    let accounts = [];
    try { accounts = await db.listMsAccounts(); }
    catch (e) { log('error', 'ms_backfill_list_failed', { error: e.message }); return stats; }
    const day = new Date().toISOString().slice(0, 10);
    for (const acc of accounts) {
      const channelId = acc.channel_id;
      if (inFlight.has(channelId)) continue;   // канал сейчас бэкфиллится — лимит МС не делим
      const state = await db.getMsBackfillState(channelId).catch(() => null);
      if (!state || state.status !== 'done') continue;
      let token;
      try {
        // Дешифровка ДО claim'а дня (урок msCollectionJob): битый ключ не сжигает день.
        token = msCrypto.decrypt(acc.access_token_enc);
      } catch (e) {
        log('warn', 'ms_token_decrypt_failed', { channelId, error: e.message });
        stats.errors++;
        continue;
      }
      try {
        const key = `${channelId}:${acc.ms_account_id || 'unknown'}:${day}`;
        const out = await db.runJobOnce('ms_orders_topup', key, async () => {
          const now = new Date();
          const from = fmtDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - MS_ORDERS_TOPUP_WINDOW_DAYS));
          let n = 0;
          await fetchWindowPages(token, from, fmtDay(now), async (rows) => {
            if (rows.length) await db.upsertMsOrders(channelId, rows);
            n += rows.length;
          });
          return n;
        });
        if (out.skipped) { stats.skipped++; continue; }
        stats.channels++;
        stats.orders += Number(out.result) || 0;
      } catch (e) {
        stats.errors++;
        log('error', 'ms_orders_topup_failed', { channelId, error: e.message });
      }
    }
    return stats;
  }

  // Единый вход для recovery-бегунка (ms-lane, после дневного архива): сперва resume брошенных
  // прогонов, затем дневная доливка. Последовательно — оба пути бьют один per-account лимит МС.
  async function runMsOrdersPass() {
    const resumeStats = await resume();
    const topup = await runTopupPass();
    return { resume: resumeStats, topup };
  }

  return { start, resume, runTopupPass, runMsOrdersPass, isBusy };
}

module.exports = {
  createMsBackfillEngine,
  MS_BACKFILL_FRESH_RUNNING_SECONDS,
  MS_BACKFILL_STALE_RESUME_SECONDS,
};
