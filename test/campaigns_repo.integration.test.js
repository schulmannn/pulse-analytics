'use strict';

// Integration-тесты campaignsRepo («Кампании») — на РЕАЛЬНОМ Postgres. Без TEST_DATABASE_URL
// всё SKIP'ается (как users/channels/collector). Локальный стенд:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test
// Каждый прогон живёт на своих строках (nonce в email/username) и чистит за собой.
// Схему НЕ мигрирует сам — CI/стенд прогоняет node server/migrate.js заранее.

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `camp${Date.now().toString(36)}${process.pid}`;
const mail = (tag) => `${tag}.${nonce}@it.local`;

// Пользователи/каналы сцены (наполняется в before): A — владелец, B — посторонний/viewer.
const S = {};

test.before(async () => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });

  S.userA = await db.createUser({ email: mail('a'), pass_hash: 'x', role: 'user', status: 'active' });
  S.userB = await db.createUser({ email: mail('b'), pass_hash: 'x', role: 'user', status: 'active' });

  // TG-канал A (workspace штампуется в createTgChannel), IG-канал A, «legacy»-канал A без
  // workspace (только creator видит — сценарий недоступного читателю источника), канал B.
  S.tgA = await db.createTgChannel({
    owner_uid: S.userA.id, tg_channel_id: Date.now(), username: `tga_${nonce}`, title: 'TG A',
  });
  S.igA = await db.createIgChannel({ owner_uid: S.userA.id, username: `iga_${nonce}` });
  S.tgHidden = await db.createTgChannel({
    owner_uid: S.userA.id, tg_channel_id: Date.now() + 3, username: `hidden_${nonce}`, title: 'Hidden A',
  });
  const legacy = await pool.query(
    `INSERT INTO channels (owner_uid, username, title, status, source)
     VALUES ($1, $2, 'Legacy A', 'active', 'collector') RETURNING id`,
    [S.userA.id, `leg_${nonce}`]);
  S.legacyA = { id: legacy.rows[0].id };
  S.tgB = await db.createTgChannel({
    owner_uid: S.userB.id, tg_channel_id: Date.now() + 7, username: `tgb_${nonce}`, title: 'TG B',
  });

  // Архив TG-постов канала A: три поста кампании (10–12 июня) + три «обычных» в предыдущем
  // равном окне (бейзлайн для comparison) + пост legacy-канала.
  const seed = [
    [101, '2026-06-10T10:00:00Z', 1000, 10, 5, 2, 'photo', 'Запуск: пост 1'],
    [102, '2026-06-11T10:00:00Z', 2000, 20, 8, 3, 'video', 'Запуск: пост 2'],
    [103, '2026-06-12T10:00:00Z', 6000, 60, 20, 9, 'photo', 'Запуск: пост 3'],
    [90, '2026-06-07T10:00:00Z', 500, 5, 1, 0, 'photo', 'до кампании 1'],
    [91, '2026-06-08T10:00:00Z', 700, 7, 2, 1, 'text', 'до кампании 2'],
    [92, '2026-06-09T10:00:00Z', 900, 9, 3, 1, 'photo', 'до кампании 3'],
  ];
  for (const [id, date, views, reactions, forwards, replies, mediaType, caption] of seed) {
    await pool.query(
      `INSERT INTO posts (post_id, channel_id, date_published, views, reactions, forwards, replies, media_type, caption)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (channel_id, post_id) DO NOTHING`,
      [id, S.tgA.id, date, views, reactions, forwards, replies, mediaType, caption]);
  }
  await pool.query(
    `INSERT INTO posts (post_id, channel_id, date_published, views, media_type, caption)
     VALUES (201, $1, '2026-06-11T09:00:00Z', 4000, 'photo', 'legacy post')
     ON CONFLICT (channel_id, post_id) DO NOTHING`, [S.legacyA.id]);
  await pool.query(
    `INSERT INTO posts (post_id, channel_id, date_published, views, media_type, caption)
     VALUES (202, $1, '2026-06-11T09:00:00Z', 4000, 'photo', 'temporarily hidden post')
     ON CONFLICT (channel_id, post_id) DO NOTHING`, [S.tgHidden.id]);

  // IG-медиа: две дневные точки (сводка обязана взять СВЕЖУЮ, day 2026-06-12).
  for (const [day, reach, likes, comments, saved, shares, views] of [
    ['2026-06-11', 300, 30, 3, 2, 1, 500],
    ['2026-06-12', 800, 80, 8, 5, 4, 1200],
  ]) {
    await pool.query(
      `INSERT INTO ig_media_daily (channel_id, media_id, day, reach, likes, comments, saved, shares, views)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (channel_id, media_id, day) DO NOTHING`,
      [S.igA.id, `media_${nonce}`, day, reach, likes, comments, saved, shares, views]);
  }
});

test.after(async () => {
  if (!pool) return;
  // users → CASCADE: workspaces → campaigns → campaign_posts; channels → posts/ig_media_daily.
  // external_sources чистим ПОСЛЕ users: до каскада на них ещё ссылаются channels.source_id.
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM external_sources WHERE username LIKE $1`, [`%${nonce}%`]);
  await pool.end();
});

test('CRUD: create → get/list → partial update → статусы/цвет/даты', { skip }, async () => {
  const created = await db.createCampaign(S.userA.id, {
    channel_id: S.tgA.id,
    name: `Запуск ${nonce}`, description: 'Продуктовый запуск', color: '#2d6be0',
    start_date: '2026-06-10', end_date: '2026-06-12',
  });
  assert.ok(created && created.id, 'createCampaign вернул строку');
  assert.strictEqual(created.status, 'active');
  assert.strictEqual(created.my_role, 'owner');
  assert.strictEqual(created.post_count, 0);
  assert.strictEqual(created.created_by, S.userA.id);
  S.campaign = created;

  const got = await db.getCampaign(S.userA.id, created.id);
  assert.strictEqual(got.name, `Запуск ${nonce}`);
  assert.strictEqual(got.start_date, '2026-06-10');

  const listed = await db.listCampaigns(S.userA.id, {});
  assert.ok(listed.some((c) => c.id === created.id), 'кампания видна в списке владельца');
  const scoped = await db.listCampaigns(S.userA.id, { channelId: S.tgA.id });
  assert.ok(scoped.some((c) => c.id === created.id), 'выбранный источник показывает кампании своего workspace');
  const foreignScope = await db.listCampaigns(S.userA.id, { channelId: S.tgB.id });
  assert.ok(!foreignScope.some((c) => c.id === created.id), 'недоступный источник не раскрывает кампании');

  const updated = await db.updateCampaign(S.userA.id, created.id, { status: 'completed', color: null });
  assert.strictEqual(updated.status, 'completed');
  assert.strictEqual(updated.color, null, 'явный null очищает цвет');
  assert.strictEqual(updated.name, `Запуск ${nonce}`, 'partial update не трогает имя');
  const filtered = await db.listCampaigns(S.userA.id, { status: 'completed' });
  assert.ok(filtered.some((c) => c.id === created.id), 'фильтр по статусу работает');
  await db.updateCampaign(S.userA.id, created.id, { status: 'active' });
});

test('дубль имени в одном воркспейсе (case-insensitive) → campaign_name_conflict', { skip }, async () => {
  // Точный дубль — конфликт в любой локали.
  await assert.rejects(
    () => db.createCampaign(S.userA.id, { channel_id: S.tgA.id, name: `Запуск ${nonce}` }),
    (e) => e.code === 'campaign_name_conflict');
  // Case-insensitivity проверяем латиницей: lower() над кириллицей зависит от локали кластера
  // (стенд может быть в C-locale), а контракт индекса — lower(name).
  const launch = await db.createCampaign(S.userA.id, { channel_id: S.tgA.id, name: `Launch ${nonce}` });
  await assert.rejects(
    () => db.createCampaign(S.userA.id, { channel_id: S.tgA.id, name: `launch ${nonce}` }),
    (e) => e.code === 'campaign_name_conflict');
  // Апдейт в занятое имя — тоже конфликт.
  const other = await db.createCampaign(S.userA.id, { channel_id: S.tgA.id, name: `Other ${nonce}` });
  await assert.rejects(
    () => db.updateCampaign(S.userA.id, other.id, { name: `LAUNCH ${nonce}` }),
    (e) => e.code === 'campaign_name_conflict');
  await db.deleteCampaign(S.userA.id, other.id);
  await db.deleteCampaign(S.userA.id, launch.id);
});

test('membership: tg обогащается из архива, идемпотентный повтор → skipped, мусорный ref → invalid', { skip }, async () => {
  const items = [
    { network: 'tg', channel_id: S.tgA.id, post_ref: '101' },
    { network: 'tg', channel_id: S.tgA.id, post_ref: '102' },
    { network: 'tg', channel_id: S.tgA.id, post_ref: '103' },
    { network: 'tg', channel_id: S.tgA.id, post_ref: '999999' }, // нет в архиве
    {
      network: 'ig', channel_id: S.igA.id, post_ref: `media_${nonce}`,
      published_at: '2026-06-11T12:00:00Z', media_type: 'REELS', caption: 'IG пост запуска',
    },
  ];
  const first = await db.addCampaignPosts(S.userA.id, S.campaign.id, items);
  assert.deepStrictEqual(
    { added: first.added, skipped: first.skipped, invalid: first.invalid.length },
    { added: 4, skipped: 0, invalid: 1 });
  assert.strictEqual(first.invalid[0].reason, 'post_not_found');

  const second = await db.addCampaignPosts(S.userA.id, S.campaign.id, items);
  assert.deepStrictEqual(
    { added: second.added, skipped: second.skipped },
    { added: 0, skipped: 4 },
    'повторное добавление тех же постов идемпотентно');

  const rows = await db.listCampaignPosts(S.userA.id, S.campaign.id);
  assert.strictEqual(rows.length, 4);
  const tg101 = rows.find((r) => r.network === 'tg' && r.post_ref === '101');
  assert.strictEqual(tg101.tg_views, 1000, 'метрики tg читаются из архива на лету');
  assert.strictEqual(tg101.media_type, 'photo', 'метаданные tg взяты из архива, не от клиента');
  assert.ok(tg101.published_at && tg101.published_at.startsWith('2026-06-10'));
  const ig = rows.find((r) => r.network === 'ig');
  assert.strictEqual(ig.ig_reach, 800, 'ig-метрики — СВЕЖАЯ строка ig_media_daily');
  assert.strictEqual(ig.ig_views, 1200);
  assert.strictEqual((await db.getCampaign(S.userA.id, S.campaign.id)).post_count, 4);
});

test('нельзя добавить пост из недоступного канала → campaign_channel_forbidden', { skip }, async () => {
  await assert.rejects(
    () => db.addCampaignPosts(S.userA.id, S.campaign.id, [
      { network: 'tg', channel_id: S.tgB.id, post_ref: '101' },
    ]),
    (e) => e.code === 'campaign_channel_forbidden' && e.channels.includes(S.tgB.id));
});

test('изоляция: чужая кампания не читается и не изменяется', { skip }, async () => {
  assert.strictEqual(await db.getCampaign(S.userB.id, S.campaign.id), null);
  assert.strictEqual(await db.updateCampaign(S.userB.id, S.campaign.id, { name: 'hack' }), null);
  assert.strictEqual(await db.deleteCampaign(S.userB.id, S.campaign.id), false);
  assert.strictEqual(await db.addCampaignPosts(S.userB.id, S.campaign.id, [
    { network: 'tg', channel_id: S.tgB.id, post_ref: '1' },
  ]), null);
  assert.strictEqual(await db.listCampaignPosts(S.userB.id, S.campaign.id), null);
  assert.strictEqual(await db.getCampaignSummary(S.userB.id, S.campaign.id), null);
  const listed = await db.listCampaigns(S.userB.id, {});
  assert.ok(!listed.some((c) => c.id === S.campaign.id));
});

test('роли: viewer читает, но не пишет; member пишет; disabled-источник → заглушка', { skip }, async () => {
  const ws = S.campaign.workspace_id;
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1,$2,'viewer')
     ON CONFLICT (workspace_id, uid) DO UPDATE SET role='viewer'`, [ws, S.userB.id]);

  const asViewer = await db.getCampaign(S.userB.id, S.campaign.id);
  assert.strictEqual(asViewer.my_role, 'viewer', 'viewer видит кампанию');
  assert.strictEqual(await db.updateCampaign(S.userB.id, S.campaign.id, { name: 'viewer edit' }), null,
    'write-предикат в WHERE не пускает viewer');
  await assert.rejects(
    () => db.createCampaign(S.userB.id, { channel_id: S.tgA.id, name: `Viewer ${nonce}` }),
    (e) => e.code === 'campaign_role_forbidden');
  await assert.rejects(
    () => db.addCampaignPosts(S.userB.id, S.campaign.id, [
      { network: 'tg', channel_id: S.tgA.id, post_ref: '101' },
    ]),
    (e) => e.code === 'campaign_role_forbidden');
  await assert.rejects(
    () => db.removeCampaignPosts(S.userB.id, S.campaign.id, [
      { network: 'tg', channel_id: S.tgA.id, post_ref: '101' },
    ]),
    (e) => e.code === 'campaign_role_forbidden');

  // A добавляет пост из того же workspace, после чего источник отключается.
  const add = await db.addCampaignPosts(S.userA.id, S.campaign.id, [
    { network: 'tg', channel_id: S.tgHidden.id, post_ref: '202' },
  ]);
  assert.strictEqual(add.added, 1);
  await pool.query(`UPDATE channels SET status='disabled' WHERE id=$1`, [S.tgHidden.id]);
  const rowsForB = await db.listCampaignPosts(S.userB.id, S.campaign.id);
  const stub = rowsForB.find((r) => r.channel_id === S.tgHidden.id);
  assert.strictEqual(stub.accessible, false, 'disabled-источник — заглушка без метрик');
  assert.strictEqual(stub.tg_views, null, 'метрики недоступного источника не отдаются');
  assert.strictEqual(stub.channel_title, null);
  await pool.query(`UPDATE channels SET status='active' WHERE id=$1`, [S.tgHidden.id]);

  await pool.query(
    `UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND uid=$2`, [ws, S.userB.id]);
  const asMember = await db.updateCampaign(S.userB.id, S.campaign.id, { description: 'member edit' });
  assert.strictEqual(asMember.description, 'member edit', 'member может изменять');
});

test('membership не пересекает workspace и не принимает неверную платформу', { skip }, async () => {
  await assert.rejects(
    () => db.addCampaignPosts(S.userA.id, S.campaign.id, [
      { network: 'tg', channel_id: S.legacyA.id, post_ref: '201' },
    ]),
    (e) => e.code === 'campaign_workspace_mismatch');
  await assert.rejects(
    () => db.addCampaignPosts(S.userA.id, S.campaign.id, [
      { network: 'ig', channel_id: S.tgA.id, post_ref: 'fake' },
    ]),
    (e) => e.code === 'campaign_network_mismatch');

  await assert.rejects(
    () => pool.query(
      `INSERT INTO campaign_posts (campaign_id, workspace_id, network, channel_id, post_ref, added_by)
       VALUES ($1,$2,'tg',$3,'201',$4)`,
      [S.campaign.id, S.campaign.workspace_id, S.legacyA.id, S.userA.id]),
    (e) => e.code === '23503',
    'composite FK не даёт обойти workspace-инвариант прямым INSERT');
});

test('summary: платформы раздельно, медиана/лучший/худший, разбивки, таймлайн, tg-comparison', { skip }, async () => {
  const s = await db.getCampaignSummary(S.userA.id, S.campaign.id);
  assert.strictEqual(s.posts_total, 5);
  assert.strictEqual(s.inaccessible_posts, 0, 'владельцу доступны все источники');

  // TG: 101/102/103 + temporarily hidden 202 → views [1000,2000,6000,4000], медиана 3000.
  assert.strictEqual(s.tg.posts, 4);
  assert.strictEqual(s.tg.views, 13000);
  assert.strictEqual(s.tg.median, 3000);
  assert.strictEqual(s.tg.avg, 3250);
  assert.strictEqual(s.tg.reactions, 90);
  assert.strictEqual(s.tg.best.post_ref, '103', 'лучший — против медианы своей платформы');
  assert.strictEqual(s.tg.best.ratio, 2);
  assert.strictEqual(s.tg.worst.post_ref, '101');

  // IG: отдельный блок, БЕЗ смешивания с tg.
  assert.strictEqual(s.ig.posts, 1);
  assert.strictEqual(s.ig.reach, 800);
  assert.strictEqual(s.ig.views, 1200);
  assert.strictEqual(s.ig.likes, 80);

  assert.strictEqual(s.by_source.length, 3);
  const tgSrc = s.by_source.find((x) => x.channel_id === S.tgA.id);
  assert.deepStrictEqual({ posts: tgSrc.posts, tg_views: tgSrc.tg_views }, { posts: 3, tg_views: 9000 });
  // tg-photo: 101, 103 + hidden-source post 202 (добавлен в тесте ролей) = 3.
  assert.ok(s.by_format.some((f) => f.network === 'tg' && f.media_type === 'photo' && f.posts === 3));
  assert.ok(s.by_format.some((f) => f.network === 'ig' && f.media_type === 'REELS' && f.posts === 1));

  assert.deepStrictEqual(s.period, { from: '2026-06-10', to: '2026-06-12' });
  assert.strictEqual(s.timeline.length, 3, 'таймлайн бинится по дням публикации');
  const day1 = s.timeline.find((t) => t.day === '2026-06-11');
  assert.deepStrictEqual(
    { posts: day1.posts, tg_views: day1.tg_views, ig_reach: day1.ig_reach },
    { posts: 3, tg_views: 6000, ig_reach: 800 });

  // Comparison: предыдущее равное окно (3 дня) содержит посты 90/91/92 → достаточно (>=3).
  assert.strictEqual(s.comparison.available, true);
  assert.strictEqual(s.comparison.network, 'tg', 'бейзлайн только по tg (дат ig-постов в БД нет)');
  assert.strictEqual(s.comparison.prev_posts, 3);
  assert.strictEqual(s.comparison.prev_views_avg, 700);
  assert.strictEqual(s.comparison.prev_views_median, 700);
});

test('summary: comparison недоступен при <3 постах в предыдущем окне', { skip }, async () => {
  const small = await db.createCampaign(S.userA.id, {
    channel_id: S.tgA.id,
    name: `Мини ${nonce}`, start_date: '2026-06-08', end_date: '2026-06-08',
  });
  await db.addCampaignPosts(S.userA.id, small.id, [
    { network: 'tg', channel_id: S.tgA.id, post_ref: '91' },
  ]);
  const s = await db.getCampaignSummary(S.userA.id, small.id);
  assert.strictEqual(s.comparison.available, false, 'в окне 2026-06-07 один пост — недостаточно');
  assert.strictEqual(s.comparison.reason, 'insufficient_data');
  await db.deleteCampaign(S.userA.id, small.id);
});

test('лимит membership: превышение потолка → campaign_limit (до вставки)', { skip }, async () => {
  const many = Array.from({ length: db.CAMPAIGN_POSTS_LIMIT + 1 }, (_, i) => ({
    network: 'ig', channel_id: S.igA.id, post_ref: `bulk_${i}`,
  }));
  await assert.rejects(
    () => db.addCampaignPosts(S.userA.id, S.campaign.id, many),
    (e) => e.code === 'campaign_limit');
});

test('лимит membership атомарен для конкурентных batch и не считает invalid TG', { skip }, async () => {
  const campaign = await db.createCampaign(S.userA.id, {
    channel_id: S.igA.id,
    name: `Race ${nonce}`,
  });
  await pool.query(
    `INSERT INTO campaign_posts (campaign_id, workspace_id, network, channel_id, post_ref, added_by)
     SELECT $1,$2,'ig',$3,'race_' || g,$4 FROM generate_series(1,499) g`,
    [campaign.id, campaign.workspace_id, S.igA.id, S.userA.id]);

  const results = await Promise.allSettled([
    db.addCampaignPosts(S.userA.id, campaign.id, [
      { network: 'ig', channel_id: S.igA.id, post_ref: 'race_a' },
    ]),
    db.addCampaignPosts(S.userA.id, campaign.id, [
      { network: 'ig', channel_id: S.igA.id, post_ref: 'race_b' },
    ]),
  ]);
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.strictEqual(rejected.reason.code, 'campaign_limit');
  const count = await pool.query(
    `SELECT count(*)::int AS n FROM campaign_posts WHERE campaign_id=$1`, [campaign.id]);
  assert.strictEqual(count.rows[0].n, 500);

  const invalid = await db.addCampaignPosts(S.userA.id, campaign.id, [
    { network: 'tg', channel_id: S.tgA.id, post_ref: '999999' },
  ]);
  assert.deepStrictEqual(
    { added: invalid.added, invalid: invalid.invalid.length },
    { added: 0, invalid: 1 },
    'несуществующий TG-пост не занимает лимит');
  await db.deleteCampaign(S.userA.id, campaign.id);
});

test('remove membership + delete campaign: публикации никогда не удаляются', { skip }, async () => {
  const removed = await db.removeCampaignPosts(S.userA.id, S.campaign.id, [
    { network: 'tg', channel_id: S.tgA.id, post_ref: '101' },
  ]);
  assert.deepStrictEqual(removed, { removed: 1 });
  // Было 5 (101/102/103 + ig + legacy 201), минус один.
  assert.strictEqual((await db.getCampaign(S.userA.id, S.campaign.id)).post_count, 4);

  assert.strictEqual(await db.deleteCampaign(S.userA.id, S.campaign.id), true);
  assert.strictEqual(await db.getCampaign(S.userA.id, S.campaign.id), null);
  const { rows: orphan } = await pool.query(
    `SELECT count(*)::int AS cnt FROM campaign_posts WHERE campaign_id=$1`, [S.campaign.id]);
  assert.strictEqual(orphan[0].cnt, 0, 'membership удалён каскадом');
  const { rows: posts } = await pool.query(
    `SELECT count(*)::int AS cnt FROM posts WHERE channel_id=$1`, [S.tgA.id]);
  assert.strictEqual(posts[0].cnt, 6, 'сами публикации целы');
  const { rows: ig } = await pool.query(
    `SELECT count(*)::int AS cnt FROM ig_media_daily WHERE channel_id=$1`, [S.igA.id]);
  assert.strictEqual(ig[0].cnt, 2, 'ig-метрики целы');
});
