import type { CdekPoint } from '@/api/cdek';

/**
 * Календарная сетка окна честными нулями — ПО ТОЙ ЖЕ грануляции, что прислал сервер.
 *
 * Сервер СДЭКа отдаёт ТОЛЬКО непустые корзины («Пустые корзины НЕ достраиваются» —
 * getCdekSeriesForActor), и достраивать их обязан фронт: он один знает, что «нет заказов» здесь
 * ноль, а не пропуск данных. Без сетки ломались три вещи:
 *
 *   • ОСЬ ВРАЛА. 29 июля и 3 августа вставали соседними точками, если между ними не было продаж:
 *     подписи дат оставались настоящими, а расстояния между ними — нет.
 *   • СРАВНЕНИЕ МОЛЧА ПРОПАДАЛО на столбцах. BarChart требует, чтобы призрак совпадал с рядом по
 *     длине (иначе i-й столбец сравнивался бы с чужим днём), а у окон было 25 и 30 точек.
 *   • СЧЁТ ЦЕЛИ шёл по дням С ПРОДАЖАМИ: «достигнута в 0 из 25 дней» на тридцатидневном окне.
 *
 * ГРАНУЛЯЦИЮ ИГНОРИРОВАТЬ НЕЛЬЗЯ — на этом я и ошибся, выпустив дневную сетку для всех окон.
 * Сервер сам укрупняет длинные окна (defaultGrain: >31 дня — недели, >180 — месяцы), и дневная
 * сетка поверх недельных корзин вставляла между понедельниками по ШЕСТЬ нулей: график 90 дней
 * читался как «продажи раз в неделю, остальные дни пустые» (владелец: «он врёт и говорит что у
 * нас постоянно дни с нулевыми продажами»). Шаг сетки обязан совпадать с шагом корзин.
 */
const DAY_MS = 86_400_000;
/** Потолок числа корзин: кривой ответ сервера не должен обернуться миллионом узлов в памяти. */
const MAX_BUCKETS = 1200;

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Понедельник недели, содержащей дату (ключи недельных корзин — date_trunc('week') = понедельник). */
function mondayOf(ms: number): number {
  const d = new Date(ms);
  const shift = (d.getUTCDay() + 6) % 7;
  return ms - shift * DAY_MS;
}

/** Полная длина корзины в днях: столько дней она накрывает, когда лежит внутри окна целиком. */
export function bucketFullDays(grain: string, key: string): number {
  if (grain === 'week') return 7;
  if (grain !== 'month') return 1;
  const ms = Date.parse(`${key}T00:00:00Z`);
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Единица корзины для подписей: окно 90 дней показано НЕДЕЛЯМИ, и называть их днями нельзя. */
export function bucketWords(grain: string): [string, string, string] {
  if (grain === 'week') return ['недели', 'недель', 'недель'];
  if (grain === 'month') return ['месяца', 'месяцев', 'месяцев'];
  return ['дня', 'дней', 'дней'];
}

export interface CdekBucket {
  key: string;
  /** Сколько дней ОКНА накрывает корзина: у краевых меньше полной длины. */
  days: number;
  /** Корзина покрыта окном не целиком — её величина несравнима с соседними. */
  partial: boolean;
}

/**
 * Сетка окна с длиной каждой корзины.
 *
 * КРАЕВЫЕ КОРЗИНЫ НЕПОЛНЫЕ. Окно «90 дней» почти никогда не начинается в понедельник и не кончается
 * в воскресенье: первая неделя может быть покрыта одним днём из семи, последняя — пятью. Рисовать их
 * наравне с полными значит показывать скачок в начале и обвал в конце у совершенно ровного бизнеса —
 * а правый край читают как «что происходит сейчас», и он падал ВСЕГДА: на 90д, 365д и «Всё».
 */
export function cdekGrid(from: string, to: string, grain: string): CdekBucket[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const keys = cdekGridKeys(from, to, grain);
  return keys.map((key) => {
    const full = bucketFullDays(grain, key);
    const bucketStart = Date.parse(`${key}T00:00:00Z`);
    const bucketEnd = bucketStart + (full - 1) * DAY_MS;
    const covered =
      Math.round((Math.min(bucketEnd, end) - Math.max(bucketStart, start)) / DAY_MS) + 1;
    const days = Math.max(0, Math.min(full, covered));
    return { key, days, partial: days > 0 && days < full };
  });
}

/** Ключи сетки окна для заданной грануляции — ровно те, какими их печатает date_trunc. */
export function cdekGridKeys(from: string, to: string, grain: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const keys: string[] = [];
  if (grain === 'month') {
    const d = new Date(start);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth();
    // Потолок на случай кривого ответа: сто лет корзин в память не кладём.
    for (let guard = 0; guard <= MAX_BUCKETS; guard += 1) {
      const ms = Date.UTC(y, m, 1);
      if (ms > end) break;
      keys.push(iso(ms));
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
    return keys;
  }
  const step = grain === 'week' ? 7 * DAY_MS : DAY_MS;
  const first = grain === 'week' ? mondayOf(start) : start;
  for (let ms = first, guard = 0; ms <= end && guard <= MAX_BUCKETS; ms += step, guard += 1) keys.push(iso(ms));
  return keys;
}

/**
 * @param grain — грануляция ИЗ ОТВЕТА сервера (`day` | `week` | `month`), а не из желания клиента.
 */
export function densifyCdekDays(
  points: readonly CdekPoint[],
  from: string | null | undefined,
  to: string | null | undefined,
  grain: string | null | undefined = 'day',
): CdekPoint[] {
  if (!from || !to) return [...points];
  const keys = cdekGridKeys(from, to, grain ?? 'day');
  // Сетка не построилась (кривое окно), упёрлась в потолок (абсурдное окно) или короче самого
  // ответа — отдаём ряд как есть: терять реальные корзины ради ровной оси нельзя.
  if (keys.length === 0 || keys.length > MAX_BUCKETS || keys.length < points.length) return [...points];
  const byDay = new Map(points.map((p) => [p.day, p]));
  return keys.map((key) => byDay.get(key) ?? { day: key, revenue: 0, orders: 0, items: 0 });
}
