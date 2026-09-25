import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { RusenderErrorState, retryCanHelp } from '@/panels/rusender/RusenderErrorState';

/**
 * Ошибка витрины Rusender называет причину (P0 rusender-range).
 *
 * Сервер режет явное окно from/to шире 400 дней честной 400-кой с подсказкой. Панели же рисовали
 * ErrorState без reason: на кастомном диапазоне в 401+ день пользователь видел «Не удалось
 * загрузить» и «Повторить», который возвращал тот же отказ.
 */

// Текст 400-ки из server/routes/rusender.js (parseRange) — то, что ApiError несёт в message.
const RANGE_TOO_WIDE =
  'Слишком широкий диапазон дат: максимум 400 дней. Для всей истории выберите период «Всё»';

const render = (error: unknown) =>
  renderToStaticMarkup(
    <RusenderErrorState query={{ error, isFetching: false, refetch: () => undefined }} />,
  );

describe('RusenderErrorState', () => {
  it('окно шире потолка: показывает текст сервера и не предлагает бесполезный повтор', () => {
    const html = render(new ApiError(400, RANGE_TOO_WIDE));
    expect(html).toContain('role="alert"');
    expect(html).toContain('Не удалось загрузить');
    expect(html).toContain('Слишком широкий диапазон дат: максимум 400 дней.');
    expect(html).toContain('выберите период «Всё»');
    expect(html).not.toContain('Повторить');
  });

  it('5xx и обрыв сети: причина видна, повтор остаётся', () => {
    const server = render(new ApiError(503, 'Сервер временно недоступен — попробуйте позже'));
    expect(server).toContain('Сервер временно недоступен — попробуйте позже');
    expect(server).toContain('Повторить');

    const offline = new ApiError(0, 'Нет соединения с сервером — проверьте интернет и попробуйте ещё раз');
    offline.network = true;
    const net = render(offline);
    expect(net).toContain('Нет соединения с сервером');
    expect(net).toContain('Повторить');
  });

  it('не-Error причина — нейтральное «ошибка», повтор остаётся', () => {
    const html = render('boom');
    expect(html).toContain('ошибка');
    expect(html).toContain('Повторить');
  });
});

describe('retryCanHelp', () => {
  it('4xx — нет (тот же запрос вернёт тот же отказ)', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(retryCanHelp(new ApiError(status, 'x')), String(status)).toBe(false);
    }
  });

  it('408/429, 5xx, сеть, дрейф схемы и чужие ошибки — да', () => {
    for (const status of [408, 429, 500, 502, 503]) {
      expect(retryCanHelp(new ApiError(status, 'x')), String(status)).toBe(true);
    }
    const offline = new ApiError(0, 'x');
    offline.network = true;
    expect(retryCanHelp(offline)).toBe(true);
    expect(retryCanHelp(new ApiError(0, 'Формат данных не совпадает с ожидаемым'))).toBe(true);
    expect(retryCanHelp(new Error('x'))).toBe(true);
    expect(retryCanHelp(null)).toBe(true);
  });
});

// SOURCE-КОНТРАКТ (образец captions.test.ts): все четыре витрины рисуют провал запроса через
// RusenderErrorState, а не голым ErrorState без причины — иначе регрессия вернётся тихо.
const PANELS = [
  'RusenderOverview.tsx',
  'RusenderMetricPage.tsx',
  'RusenderCampaigns.tsx',
  'RusenderAudience.tsx',
] as const;

const readPanel = (file: string) =>
  readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');

describe('Витрины Rusender показывают причину ошибки', () => {
  for (const file of PANELS) {
    it(`${file}: isError → RusenderErrorState`, () => {
      const source = readPanel(file);
      expect(source, 'голый ErrorState теряет текст сервера').not.toMatch(/<ErrorState\b/);
      expect(source).toMatch(/<RusenderErrorState query=\{\w+\} \/>/);
    });
  }

  it('RusenderMetricPage: при ошибке шапка и пикер «Окно» остаются — иначе окно шире потолка не сменить', () => {
    const source = readPanel('RusenderMetricPage.tsx');
    const branch = source.slice(source.indexOf('if (summary.isError)'));
    const body = branch.slice(0, branch.indexOf('\n  }\n') + 4);
    expect(body).toContain('<RusenderMetricShell');
    expect(body).toContain('<RusenderErrorState query={summary} />');
    expect(body).toContain('{windowBar}');
    expect(source).toMatch(/const windowBar = \(\s*<WindowBarShell>\s*<PeriodChips/);
  });
});
