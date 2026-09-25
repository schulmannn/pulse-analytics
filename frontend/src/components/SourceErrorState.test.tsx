import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { SourceErrorState } from '@/components/SourceErrorState';

/**
 * Провал запроса МойСклада/Метрики: отзыв токена — состояние доступа с путём наружу, а не
 * «сбой, повторите». Обе формы отзыва (нынешний 401 с кодом и будущий 409 source_reauth) дают один
 * и тот же экран; всё остальное остаётся прежним ErrorState.
 */

const apiError = (status: number, message: string, code?: string) => {
  const error = new ApiError(status, message);
  if (code) error.code = code;
  return error;
};

const render = (source: 'ms' | 'ym', error: unknown, compact = false) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SourceErrorState
        source={source}
        error={error}
        compact={compact}
        size={compact ? 'chart' : undefined}
        className={compact ? 'py-4' : undefined}
        title="Не удалось получить данные"
        reason={error instanceof Error ? error.message : 'ошибка'}
        onRetry={() => undefined}
      />
    </MemoryRouter>,
  );

const MS_REVOKED = [
  apiError(401, 'Токен отозван МойСкладом — переподключите источник', 'ms_token_revoked'),
  apiError(409, 'Токен отозван — переподключите источник', 'source_reauth'),
];
const YM_REVOKED = [
  apiError(401, 'Токен отозван Яндексом — переподключите источник', 'ym_token_revoked'),
  apiError(409, 'Токен отозван — переподключите источник', 'source_reauth'),
];

describe('SourceErrorState: отзыв токена', () => {
  it('МойСклад: обе формы отзыва → «Переподключить», без «Повторить» и без alert', () => {
    for (const error of MS_REVOKED) {
      const page = render('ms', error);
      expect(page).toContain('Токен МойСклада отозван');
      expect(page).toContain('Переподключить МойСклад');
      expect(page).toContain('href="/connect?source=moysklad"');
      expect(page).toContain('История продаж сохранится');
      expect(page).not.toContain('Повторить');
      expect(page).not.toContain('role="alert"');

      const card = render('ms', error, true);
      expect(card).toContain('Токен МойСклада отозван');
      expect(card).toContain('href="/connect?source=moysklad"');
      expect(card).toContain('>Переподключить<');
      expect(card).not.toContain('Повторить');
    }
  });

  it('Метрика: обе формы отзыва → «Переподключить Метрику»', () => {
    for (const error of YM_REVOKED) {
      const page = render('ym', error);
      expect(page).toContain('Токен Яндекса отозван');
      expect(page).toContain('Переподключить Метрику');
      expect(page).toContain('href="/connect?source=metrika"');
      expect(page).not.toContain('Повторить');

      const card = render('ym', error, true);
      expect(card).toContain('Токен Яндекса отозван');
      expect(card).toContain('href="/connect?source=metrika"');
      expect(card).not.toContain('Повторить');
    }
  });

  it('раскладка та же: compact/size/className переходят в состояние доступа', () => {
    const access = render('ms', MS_REVOKED[0], true);
    const failure = render('ms', apiError(503, 'МойСклад недоступен'), true);
    for (const html of [access, failure]) {
      // Резерв высоты графика и отступ вызывающего — одни и те же, подмена не дёргает плитку.
      expect(html).toContain('min-h-40');
      expect(html).toContain('py-4');
    }
  });
});

describe('SourceErrorState: нехватка прав МойСклада (403 ms_forbidden)', () => {
  const forbidden = apiError(403, 'МойСклад отказал в доступе: у сотрудника, чей токен подключён, нет прав на эти данные', 'ms_forbidden');

  it('называет права и не ведёт на /connect — чинится в МойСкладе, не у нас', () => {
    const page = render('ms', forbidden);
    expect(page).toContain('Не хватает прав в МойСкладе');
    expect(page).toContain('Прибыльность');
    expect(page).not.toContain('href="/connect');
    expect(page).not.toContain('Повторить');

    const card = render('ms', forbidden, true);
    expect(card).toContain('Не хватает прав в МойСкладе');
    expect(card).toContain('обновите страницу');
    expect(card).not.toContain('<a ');
  });
});

describe('SourceErrorState: всё остальное — прежний ErrorState', () => {
  it('401 без кода (наша сессия), 404, 5xx и обрыв сети: заголовок, причина и «Повторить» как раньше', () => {
    const offline = apiError(0, 'Нет соединения с сервером');
    offline.network = true;
    for (const error of [
      apiError(401, 'Сессия истекла, войди снова'),
      apiError(404, 'МойСклад не подключён к этому каналу'),
      apiError(502, 'МойСклад недоступен'),
      offline,
      new Error('boom'),
    ]) {
      const html = render('ms', error);
      expect(html).toContain('role="alert"');
      expect(html).toContain('Не удалось получить данные');
      expect(html).toContain(error.message);
      expect(html).toContain('Повторить');
      expect(html).not.toContain('отозван');
    }
  });

  it('у Метрики нет своего «нет прав»: чужой код не превращается в экран МойСклада', () => {
    const html = render('ym', apiError(403, 'x', 'ms_forbidden'));
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('МойСклад');
  });
});

// SOURCE-КОНТРАКТ (образец RusenderErrorState.test): каждая поверхность МойСклада и Метрики рисует
// провал data-роута через SourceErrorState. Голый ErrorState снова спрятал бы «Переподключить» за
// «Повторить» — а при смене формы отзыва на 409 никто бы этого не заметил. Папка задаёт источник:
// `source="ym"` в теле МойСклада повёл бы отзыв его токена на /connect Метрики. `error=` и `reason=`
// — одна и та же ошибка: иначе состояние выбирается по одному запросу, а текст берётся из другого.
const PANEL_DIRS = [
  ['../panels/sklad', 'ms'],
  ['../panels/metrika', 'ym'],
] as const;

describe('Поверхности МойСклада и Метрики разбирают ошибку запроса через sourceErrorKind', () => {
  for (const [dir, network] of PANEL_DIRS) {
    const url = new URL(`${dir}/`, import.meta.url);
    const files = readdirSync(fileURLToPath(url)).filter((file) => file.endsWith('.tsx') && !file.includes('.test.'));
    for (const file of files) {
      it(`${dir.replace('../', '')}/${file}`, () => {
        const source = readFileSync(fileURLToPath(new URL(file, url)), 'utf8');
        expect(source.match(/<ErrorState\b/g) ?? [], 'голый ErrorState').toEqual([]);
        for (const [block] of source.matchAll(/<SourceErrorState\b[\s\S]*?\/>/g)) {
          expect(block, 'источник папки').toContain(`source="${network}"`);
          const error = /\serror=\{([\w.]+)\}/.exec(block)?.[1];
          expect(error, `error= ошибки запроса в\n${block}`).toBeDefined();
          expect(block, 'reason= из той же ошибки').toMatch(new RegExp(`\\sreason=\\{${(error ?? '').replace(/\./g, '\\.')}\\b`));
        }
      });
    }
  }

  it('Обзоры не ветвятся по статусу или легаси-коду, только по sourceErrorKind', () => {
    for (const file of ['../panels/sklad/MsOverview.tsx', '../panels/metrika/YmOverview.tsx']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source, file).not.toMatch(/status === 40\d/);
      expect(source, file).not.toMatch(/code === '/);
      expect(source, file).toContain('sourceErrorKind(summary.error)');
    }
  });
});
