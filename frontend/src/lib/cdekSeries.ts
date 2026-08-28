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
