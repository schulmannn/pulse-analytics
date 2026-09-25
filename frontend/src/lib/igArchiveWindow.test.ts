import { describe, expect, it } from 'vitest';
import { NO_BASIS_ALL_TIME, NO_BASIS_CUSTOM_RANGE, NO_BASIS_SHORT_ARCHIVE } from '@/lib/delta';
import { igArchiveCoverageNote, igArchiveEmpty, igWindowPlan, inPlanDays, isIgLiveWindow } from '@/lib/igArchiveWindow';
import { dayKeyOf, endOfLocalDay, startOfLocalDay } from '@/lib/periodWindow';

const DAY_MS = 86_400_000;
// Якорь — «сейчас» прогона (канон тестов с окнами: не литерал рядом с немокнутым now).
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const fmtDay = (d: string) => `«${d}»`;

describe('igWindowPlan — какое окно живое, какое архивное (OD-13)', () => {
  it.each([7, 30, 90])('пресет %i д без своего периода — live, окно агрегата сервера', (days) => {
    const plan = igWindowPlan({ days, range: null, now: NOW });
    expect(plan.mode).toBe('live');
    expect(plan.days).toBe(days);
    expect(plan.insDays).toBe(days);
    expect(plan.since).toBe(NOW - days * DAY_MS);
    expect(plan.until).toBe(NOW);
    expect(plan.label).toBe(`${days} дн.`);
    expect(plan.noBasisReason).toBe(NO_BASIS_SHORT_ARCHIVE);
    expect(isIgLiveWindow(days, null)).toBe(true);
  });

  it('«Всё» — архив от первого дня bounds, без 90-дневного потолка, подпись «всё время»', () => {
    const first = dayKeyOf(NOW - 540 * DAY_MS, 'UTC');
    const plan = igWindowPlan({ days: 0, range: null, now: NOW, bounds: { first_day: first, last_day: dayKeyOf(NOW - DAY_MS, 'UTC') } });
    expect(plan.mode).toBe('archive');
    expect(plan.days).toBe(0);
    expect(plan.fromDay).toBe(first);
    expect(plan.since).toBe(Date.parse(`${first}T00:00:00Z`));
    expect(plan.until).toBe(NOW);
    expect(plan.label).toBe('всё время');
    expect(plan.noBasisReason).toBe(NO_BASIS_ALL_TIME);
    expect(plan.insDays).toBe(90);
    expect(isIgLiveWindow(0, null)).toBe(false);
  });

  it('«Всё» без bounds: первая строка архива, затем первая живая точка, иначе без начала', () => {
    const row = dayKeyOf(NOW - 200 * DAY_MS, 'UTC');
    expect(igWindowPlan({ days: 0, range: null, now: NOW, firstRowDay: row }).fromDay).toBe(row);
    const live = NOW - 80 * DAY_MS;
    expect(igWindowPlan({ days: 0, range: null, now: NOW, firstLiveMs: live }).fromDay).toBe(dayKeyOf(live, 'UTC'));
    const bare = igWindowPlan({ days: 0, range: null, now: NOW });
    expect(bare.fromDay).toBeNull();
    expect(bare.since).toBe(NOW);
  });

  it('свой период — архив ровно по выбранным календарным дням, любой длины (прошлый год)', () => {
    const from = startOfLocalDay(NOW - 400 * DAY_MS);
    const to = endOfLocalDay(NOW - 200 * DAY_MS);
    const plan = igWindowPlan({ days: 30, range: { from, to }, now: NOW });
    expect(plan.mode).toBe('archive');
    expect(plan.custom).toBe(true);
    expect(plan.fromDay).toBe(dayKeyOf(from, 'local'));
    expect(plan.toDay).toBe(dayKeyOf(to, 'local'));
    expect(plan.days).toBe(201);
    expect(plan.label).toBe('выбранный период');
    expect(plan.noBasisReason).toBe(NO_BASIS_CUSTOM_RANGE);
    expect(inPlanDays(plan, plan.fromDay ?? '')).toBe(true);
    expect(inPlanDays(plan, dayKeyOf(from - DAY_MS, 'local'))).toBe(false);
    expect(inPlanDays(plan, dayKeyOf(to + DAY_MS, 'local'))).toBe(false);
    expect(inPlanDays(plan, 'garbage')).toBe(false);
  });

  it('свой период даже на пресетной длине — архив, не живой агрегат «до сейчас»', () => {
    const from = startOfLocalDay(NOW - 29 * DAY_MS);
    const plan = igWindowPlan({ days: 30, range: { from, to: endOfLocalDay(NOW) }, now: NOW });
    expect(plan.mode).toBe('archive');
  });
});

describe('igArchiveCoverageNote — честные подписи покрытия только на архивных окнах', () => {
  const archive = igWindowPlan({ days: 0, range: null, now: NOW, bounds: { first_day: '2025-01-10', last_day: '2026-01-01' } });
  const live = igWindowPlan({ days: 30, range: null, now: NOW });

  it('живой пресет — без оговорок', () => {
    expect(igArchiveCoverageNote({ plan: live, bounds: { first_day: '2025-01-10', last_day: '2026-01-01' }, backfill: { status: 'running' }, fmtDay })).toBeNull();
  });

  it('догрузка идёт — «догружается, архив пока с …»', () => {
    expect(igArchiveCoverageNote({ plan: archive, bounds: { first_day: '2025-01-10', last_day: '2026-01-01' }, backfill: { status: 'running' }, fmtDay }))
      .toBe('История Instagram догружается — архив пока с «2025-01-10»');
  });

  it('умерший токен — «переподключите Instagram»', () => {
    expect(igArchiveCoverageNote({ plan: archive, bounds: null, backfill: { status: 'error', reason: 'ig_reauth' }, fmtDay }))
      .toBe('Догрузка истории остановлена — переподключите Instagram');
  });

  it('догрузка завершена и окно начинается раньше горизонта Graph', () => {
    const range = igWindowPlan({
      days: 30,
      range: { from: Date.parse('2024-01-01T00:00:00'), to: Date.parse('2024-12-31T23:59:59') },
      now: NOW,
    });
    expect(igArchiveCoverageNote({ plan: range, bounds: { first_day: '2024-06-01', last_day: '2026-01-01' }, backfill: { status: 'done', horizon_day: '2024-06-01' }, fmtDay }))
      .toBe('Раньше «2024-06-01» Instagram данных не отдаёт');
  });

  it('окно начинается до архива — «Архив Instagram — с …»; окно внутри архива — без подписи', () => {
    const before = igWindowPlan({ days: 30, range: { from: Date.parse('2024-01-01T00:00:00'), to: Date.parse('2025-03-01T23:59:59') }, now: NOW });
    expect(igArchiveCoverageNote({ plan: before, bounds: { first_day: '2025-01-10', last_day: '2026-01-01' }, backfill: { status: 'done' }, fmtDay }))
      .toBe('Архив Instagram — с «2025-01-10»');
    const inside = igWindowPlan({ days: 30, range: { from: Date.parse('2025-02-01T00:00:00'), to: Date.parse('2025-03-01T23:59:59') }, now: NOW });
    expect(igArchiveCoverageNote({ plan: inside, bounds: { first_day: '2025-01-10', last_day: '2026-01-01' }, backfill: { status: 'done' }, fmtDay })).toBeNull();
  });

  it('архив пуст, числа от живых рядов — «догружается»', () => {
    expect(igArchiveCoverageNote({ plan: archive, bounds: null, backfill: null, liveFallback: true, fmtDay })).toBe('История Instagram догружается');
  });

  it('свой период целиком до горизонта завершённой догрузки — край истории, а не «догружается»', () => {
    const range = { from: Date.parse('2024-01-01T00:00:00'), to: Date.parse('2024-01-31T23:59:59') };
    const plan = igWindowPlan({ days: 30, range, now: NOW, bounds: { first_day: '2025-06-01', last_day: '2026-01-01' } });
    const bounds = { first_day: '2025-06-01', last_day: '2026-01-01' };
    expect(igArchiveCoverageNote({ plan, bounds, backfill: { status: 'done', horizon_day: '2025-06-01' }, liveFallback: true, fmtDay }))
      .toBe('Раньше «2025-06-01» Instagram данных не отдаёт');
    // Догрузка выключена (backfill: null), окно до начала архива — тоже граница архива.
    expect(igArchiveCoverageNote({ plan, bounds, backfill: null, liveFallback: true, fmtDay }))
      .toBe('Архив Instagram — с «2025-06-01»');
  });

  it('отказ в правах на статистику — «переподключите»; скрытая история прежнего аккаунта названа', () => {
    expect(igArchiveCoverageNote({ plan: archive, bounds: null, backfill: { status: 'error', reason: 'ig_permission' }, fmtDay }))
      .toBe('Догрузка истории остановлена — у Instagram нет доступа к статистике, переподключите');
    const own = igWindowPlan({ days: 0, range: null, now: NOW, bounds: { first_day: '2025-12-01', last_day: '2026-01-01' } });
    expect(igArchiveCoverageNote({
      plan: own, bounds: { first_day: '2025-12-01', last_day: '2026-01-01' }, backfill: { status: 'done', horizon_day: null }, hiddenDays: 59, fmtDay,
    })).toBe('История прежнего аккаунта Instagram скрыта (59 дн.)');
  });
});

describe('igArchiveEmpty — когда архивному окну нужен живой фолбэк', () => {
  const base = { isError: false, isPending: false, fetchStatus: 'idle' };
  it('пустой ответ, сбой чтения и выключенный запрос (демо) — пусто; строки есть или запрос летит — нет', () => {
    expect(igArchiveEmpty({ ...base, data: { rows: [] } })).toBe(true);
    expect(igArchiveEmpty({ ...base, isError: true })).toBe(true);
    expect(igArchiveEmpty({ ...base, isPending: true, fetchStatus: 'idle' })).toBe(true);
    expect(igArchiveEmpty({ ...base, isPending: true, fetchStatus: 'fetching' })).toBe(false);
    expect(igArchiveEmpty({ ...base, data: { rows: [{}] } })).toBe(false);
  });
});
