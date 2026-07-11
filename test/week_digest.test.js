// Серверный недельный дайджест (weekDigest.js): чистая сборка NarrativeInput из архивных строк +
// гейт week-блока. Рендер-тест идёт через РЕАЛЬНЫЙ shared-движок (server/lib/narrative.gen.cjs,
// сборка: `npm run build:shared` во frontend/) и ЧЕСТНО скипается, когда артефакт не собран
// (CI test-job — DB-less и без frontend-сборки). Семантика движка закрыта 20+ vitest-тестами
// на стороне фронта — здесь проверяем серверную половину: маппинг строк → вход.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleWeekInput, reportHasWeekBlock, loadEngine } = require('../server/lib/weekDigest');

const NOW = Date.parse('2026-07-13T09:00:00.000Z'); // «понедельник утро» — момент рассылки
const DAY_MS = 24 * 60 * 60 * 1000;
const day = (ago) => new Date(NOW - ago * DAY_MS).toISOString().slice(0, 10);
const ts = (ago) => new Date(NOW - ago * DAY_MS).toISOString();

function rows() {
  // 20 дней архива: просмотры 100·(i+1), уровень базы падает на 3/день от 5000.
  const daily = Array.from({ length: 20 }, (_, i) => ({
    day: day(19 - i),
    views: 100 * (20 - (19 - i)),
    subscribers: 5000 - (19 - i) * 3,
  }));
  const posts = [
    { date_published: ts(2), caption: 'Пост недели', views: 400, reactions: 20, forwards: 4, replies: 2, erv: '6.5' },
    { date_published: ts(5), caption: null, views: 300, reactions: 9, forwards: 3, replies: 0, erv: null },
    { date_published: ts(12), caption: 'Прошлая неделя', views: 500, reactions: 25, forwards: 5, replies: 5, erv: '7.0' },
    { date_published: ts(20), caption: 'Старый', views: 200, reactions: 4, forwards: 2, replies: 0, erv: '3.0' },
    { date_published: ts(40), caption: 'За месяцем — вне 4-недельной базы', views: 900, reactions: 90, forwards: 9, replies: 9, erv: '11.0' },
  ];
  const igDaily = Array.from({ length: 14 }, (_, i) => ({
    day: day(13 - i),
    reach: 600 + i * 10,
    follows: 8,
    unfollows: 11, // отписки обгоняют → нетто −3/день (канон PR #100: gross нельзя звать ростом)
  }));
  return { daily, posts, igDaily };
}

test('assembleWeekInput: окна/нетто/avgErv/subsD7 собираются из архива по канонам фронта', () => {
  const input = assembleWeekInput(rows(), NOW);

  // viewsDaily: только последние 14 дней, старые→новые.
  assert.equal(input.viewsDaily.length, 14);
  assert.equal(input.viewsDaily[0].day, day(13));
  assert.equal(input.viewsDaily.at(-1).v, 100 * 20);

  // Посты НЕДЕЛИ: 2 из 5 (2д и 5д назад); заглушка заголовка; erv из колонки, null → формула.
  assert.equal(input.posts.length, 2);
  assert.equal(input.posts[0].title, 'Пост недели');
  assert.equal(input.posts[0].erv, 6.5);
  assert.equal(input.posts[1].title, 'Пост без текста');
  assert.equal(input.posts[1].erv, ((9 + 3 + 0) / 300) * 100);

  // avgErv: 4-недельная база = 4 поста (без 40-дневного), гейт ≥3 пройден.
  const expectedAvg = (6.5 + (12 / 300) * 100 + 7.0 + 3.0) / 4;
  assert.ok(Math.abs(input.avgErv - expectedAvg) < 1e-9);

  // База: уровень сейчас и Δ7д по ДНЯМ (не по индексу).
  assert.equal(input.subsNow, 5000);
  assert.equal(input.subsD7, 5000 - (5000 - 7 * 3));

  // IG-кода: дневной охват 14 точек; нетто подневно = follows − unfollows = −3;
  // followersNow ЧЕСТНО null (уровня базы в архиве нет — ig_daily.followers gross).
  assert.equal(input.ig.reachDaily.length, 14);
  assert.ok(input.ig.followsDaily.every((p) => p.v === -3));
  assert.equal(input.ig.followersNow, null);
});

test('assembleWeekInput: пустой IG-архив → ig отсутствует; дыры в уровне не ломают Δ7д', () => {
  const { daily, posts } = rows();
  const gappy = daily.filter((_, i) => i % 2 === 0); // архив через день
  const input = assembleWeekInput({ daily: gappy, posts, igDaily: [] }, NOW);
  assert.equal(input.ig, undefined);
  // Δ7д берёт ближайший уровень СТАРШЕ 7 дней, а не «8-й с конца».
  assert.ok(input.subsD7 != null && input.subsD7 > 0);
});

test('reportHasWeekBlock: preset week/digest = да; чужие блоки/мусор = нет', () => {
  const block = (key) => ({ id: 'x', type: 'preset', config: { key } });
  assert.equal(reportHasWeekBlock({ blocks: [block('week')] }), true);
  assert.equal(reportHasWeekBlock({ blocks: [block('kpi-summary'), block('digest')] }), true);
  assert.equal(reportHasWeekBlock({ blocks: [block('kpi-summary')] }), false);
  assert.equal(reportHasWeekBlock({ blocks: [{ id: 'z', type: 'text', config: {} }] }), false);
  assert.equal(reportHasWeekBlock({}), false);
  assert.equal(reportHasWeekBlock(null), false);
  // Legacy-строковая форма блоков (ReportConfigSchema: blocks может быть string[]) — старые
  // сохранённые отчёты не должны терять нарратив в письме.
  assert.equal(reportHasWeekBlock({ blocks: ['week'] }), true);
  assert.equal(reportHasWeekBlock({ blocks: ['kpi-summary', 'digest'] }), true);
  assert.equal(reportHasWeekBlock({ blocks: ['kpi-summary'] }), false);
});

// ── Full pipeline через РЕАЛЬНЫЙ shared-движок (скип без собранного артефакта) ──────────────
const engine = loadEngine();
const engineSkip = engine ? false : 'narrative.gen.cjs не собран (frontend: npm run build:shared)';

test('движок из бандла рендерит рассказ по серверному входу: сдвиг, база, IG-кода', { skip: engineSkip }, () => {
  const input = assembleWeekInput(rows(), NOW);
  const plain = engine.narrativeToPlain(engine.buildWeekNarrative(input));
  // Не привязываемся к формулировкам-находкам — только к несущим числам входа.
  assert.match(plain, /5\s?000/); // текущая база
  assert.ok(/Instagram/i.test(plain), 'IG-кода родилась из ig_daily-архива');
  assert.ok(plain.length > 80, 'рассказ не пустой');
});
