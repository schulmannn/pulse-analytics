// Integration tests for GDPR erasure/export (F4/F5): db.deleteUserAccount must erase EVERY
// user-linked row (cascade completeness), keep shared identity rows, anonymize the audit trail —
// and db.streamUserExport must stream the archive in bounded keyset pages without leaking
// credentials or foreign channels, with no duplication/omission across page boundaries (incl.
// equal timestamps). Same contour as tenancy.integration.test.js: needs the local stand, SKIPS
// without TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

/** Fake res-коллектор: гоняет реальный streamUserExport в память и парсит собранный JSON.
 *  write→true (без эмуляции backpressure — она покрыта юнит-тестом), end/destroy шлют 'close'. */
function collectorRes() {
  const listeners = {};
  return {
    chunks: [], writableEnded: false, destroyed: false, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    off(ev, fn) { if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn); return this; },
    emit(ev, ...a) { (listeners[ev] || []).slice().forEach((f) => f(...a)); },
    write(s) { this.chunks.push(s); return true; },
    end(cb) { this.writableEnded = true; if (cb) cb(); this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); },
    body() { return this.chunks.join(''); },
  };
}

/** Прогоняет экспорт через фейковый res на выбранном размере страницы и возвращает исход + JSON.
 *  pageSize — per-call override keyset-страницы (тестовый шов; прод-роут его не передаёт). */
async function runExport(uid, { pageSize } = {}) {
  const res = collectorRes();
  let ready = false;
  const outcome = await db.streamUserExport(uid, res, { onReady() { ready = true; }, pageSize });
  return { outcome, ready, res, json: outcome === 'ok' ? JSON.parse(res.body()) : null };
}

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `g${Date.now().toString(36)}${process.pid}`;

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM external_sources WHERE external_id LIKE $1`, [`${nonce}%`]);
  await pool.query(`DELETE FROM audit_events WHERE action LIKE $1`, [`it.${nonce}%`]);
  await pool.end();
});

async function mkUser(tag) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, pass_hash, role, status) VALUES ($1, 'x', 'user', 'active') RETURNING id`,
    [`${tag}.${nonce}@it.local`]);
  return u.id;
}

async function mkWorkspace(ownerUid, name) {
  const { rows: [w] } = await pool.query(
    `INSERT INTO workspaces (name, owner_uid) VALUES ($1, $2) RETURNING id`, [name, ownerUid]);
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
    [w.id, ownerUid]);
  return w.id;
}

async function mkNetworkSource(network, externalId, { username = null, title = null } = {}) {
  const { rows: [s] } = await pool.query(
    `INSERT INTO external_sources (network, external_id, username, title) VALUES ($1, $2, $3, $4)
     ON CONFLICT (network, external_id) DO UPDATE SET
       username = COALESCE(EXCLUDED.username, external_sources.username),
       title = COALESCE(EXCLUDED.title, external_sources.title)
     RETURNING id`, [network, externalId, username, title]);
  return s.id;
}

const mkSource = (externalId) => mkNetworkSource('tg', externalId);

async function mkChannel(ownerUid, workspaceId, sourceId, username) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO channels (owner_uid, workspace_id, source_id, username, title, status, source)
     VALUES ($1, $2, $3, $4, $4, 'active', 'collector') RETURNING id`,
    [ownerUid, workspaceId, sourceId, username]);
  return c.id;
}

/** Seed the full personal-data footprint for one user and return every id needed for asserts. */
async function seedRichUser(tag) {
  const uid = await mkUser(tag);
  const ws = await mkWorkspace(uid, `ws-${tag}-${nonce}`);
  const src = await mkSource(`${nonce}-${tag}`);
  // Production connect always canonicalises these integrations into external_sources. On a normal
  // TG/collector channel they are referenced only by the account row (channels.source_id remains TG).
  const msSrc = await mkNetworkSource('ms', `${nonce}-${tag}-ms`, { title: `MS ${tag}` });
  const ymSrc = await mkNetworkSource('ym', `${nonce}-${tag}-counter`, {
    username: `https://${tag}.example`,
    title: `Counter ${tag}`,
  });
  const ch = await mkChannel(uid, ws, src, `chan_${nonce}_${tag}`);
  await pool.query(`INSERT INTO user_prefs (uid, prefs) VALUES ($1, '{"h":1}'::jsonb)`, [uid]);
  await pool.query(
    `INSERT INTO tg_sessions (uid, tg_user_id, username, session_enc) VALUES ($1, 1, $2, 'iv:tag:SECRET_TG_SESSION')`,
    [uid, tag]);
  await pool.query(
    `UPDATE tg_sessions
        SET connection_state='degraded', last_attempt_at=now(),
            last_error_code='upstream', last_error_at=now()
      WHERE uid=$1`,
    [uid]);
  await pool.query(
    `INSERT INTO reports (uid, name, config) VALUES ($1, $2, '{"blocks":[]}'::jsonb)`,
    [uid, `report-${nonce}-${tag}`]);
  await pool.query(
    `INSERT INTO channel_daily (channel_id, day, views) VALUES ($1, CURRENT_DATE, 100)`, [ch]);
  const postId = nextPostId++;
  await pool.query(
    `INSERT INTO posts (post_id, channel_id, date_published, views) VALUES ($1, $2, now(), 50)`,
    [postId, ch]);
  await pool.query(
    `INSERT INTO ig_accounts (channel_id, ig_user_id, username, access_token_enc)
     VALUES ($1, $2, $2, 'iv:tag:SECRET_IG_TOKEN')`, [ch, `ig_${nonce}_${tag}`]);
  await pool.query(
    `INSERT INTO ig_daily (channel_id, day, reach) VALUES ($1, CURRENT_DATE, 10)`, [ch]);
  await pool.query(
    `INSERT INTO chart_annotations (channel_id, day, label, created_by) VALUES ($1, CURRENT_DATE, 'launch', $2)`,
    [ch, uid]);
  await pool.query(
    `INSERT INTO ms_orders
       (channel_id, order_id, moment, sum_kopecks, state, agent_id, agent_name, state_id, sales_channel_id, city)
     VALUES ($1, $2, now(), 15000, 'new', $3, 'Personal customer', 'state-1', 'web', 'Moscow')`,
    [ch, `${nonce}-${tag}-order`, `${nonce}-${tag}-agent`]);
  await pool.query(
    `INSERT INTO ms_returns (channel_id, return_id, moment, sum_kopecks, agent_id, agent_name)
     VALUES ($1, $2, now(), 5000, $3, 'Personal customer')`,
    [ch, `${nonce}-${tag}-return`, `${nonce}-${tag}-agent`]);
  await pool.query(
    `INSERT INTO ms_accounts (channel_id, ms_account_id, org_name, access_token_enc, source_id)
     VALUES ($1, $2, $3, 'iv:tag:SECRET_MS_TOKEN', $4)`,
    [ch, `${nonce}-${tag}-ms`, `MS ${tag}`, msSrc]);
  await pool.query(
    `INSERT INTO ms_daily (channel_id, day, revenue_kopecks, orders_count, orders_sum_kopecks)
     VALUES ($1, CURRENT_DATE, 12500, 2, 15000)`,
    [ch]);
  await pool.query(
    `INSERT INTO channel_mention_settings
       (channel_id, include_terms, exclude_terms, exclude_sources, match_mode, updated_by)
     VALUES ($1, ARRAY['brand'], ARRAY['spam'], ARRAY['noise'], 'word', $2)`,
    [ch, uid]);
  await pool.query(
    `INSERT INTO mention_notify_subscriptions (channel_id, uid, enabled, send_days, send_hour)
     VALUES ($1, $2, true, ARRAY[1, 3], 11)`,
    [ch, uid]);
  await pool.query(
    `INSERT INTO ym_accounts
       (channel_id, counter_id, counter_name, site, counter_created_day, access_token_enc, source_id)
     VALUES ($1, $2, $3, $4, CURRENT_DATE - 30, 'iv:tag:SECRET_YM_TOKEN', $5)`,
    [ch, `${nonce}-${tag}-counter`, `Counter ${tag}`, `https://${tag}.example`, ymSrc]);
  await pool.query(
    `INSERT INTO ym_daily
       (channel_id, day, visits, users, pageviews, bounce_rate, avg_visit_duration_seconds,
        page_depth, new_users, percent_new_visitors, robot_visits, robot_percentage)
     VALUES ($1, CURRENT_DATE, 100, 80, 140, 12.5, 61.5, 2.4, 20, 25, 3, 3)`,
    [ch]);
  await pool.query(
    `INSERT INTO raw_snapshots (channel_id, source, kind, day, payload)
     VALUES ($1, 'tg', 'graphs', CURRENT_DATE, jsonb_build_object('owner_marker', $2::text))`,
    [ch, `raw-${nonce}-${tag}`]);
  await pool.query(
    `INSERT INTO channel_snapshots (channel_id, data)
     VALUES ($1, jsonb_build_object(
       'subscribers', 42,
       'owner_marker', $2::text,
       'channel_photo', $3::text
     ))`,
    [ch, `snapshot-${nonce}-${tag}`, `data:image/jpeg;base64,SECRET_CHANNEL_PHOTO_${tag}`]);
  await pool.query(
    `INSERT INTO api_keys (channel_id, key_hash, key_prefix, label)
     VALUES ($1, $2, $3, $4)`,
    [ch, `SECRET_API_KEY_HASH_${nonce}_${tag}`, `pa_${tag}`, `Collector ${tag}`]);
  const { rows: [auditEvent] } = await pool.query(
    `INSERT INTO audit_events (uid, channel_id, action, request_id, ip_hash, metadata)
     VALUES ($1, $2, $3, $4, $5, jsonb_build_object('private_marker', $6::text))
     RETURNING id`,
    [
      uid, ch, `it.${nonce}.${tag}`, `SECRET_REQUEST_${tag}`, `SECRET_IP_HASH_${tag}`,
      `SECRET_AUDIT_METADATA_${tag}`,
    ]);
  const { rows: [campaign] } = await pool.query(
    `INSERT INTO campaigns
       (workspace_id, name, description, color, status, start_date, end_date, created_by)
     VALUES ($1, $2, $3, '#123456', 'active', CURRENT_DATE - 1, CURRENT_DATE + 1, $4)
     RETURNING id`,
    [ws, `Campaign ${nonce} ${tag}`, `Description ${tag}`, uid]);
  await pool.query(
    `INSERT INTO campaign_posts
       (campaign_id, workspace_id, network, channel_id, post_ref, published_at, media_type,
        caption, added_by)
     VALUES ($1, $2, 'tg', $3, $4, now(), 'post', $5, $6)`,
    [campaign.id, ws, ch, String(postId), `caption-${nonce}-${tag}`, uid]);
  const { rows: [aiChat] } = await pool.query(
    `INSERT INTO ai_chats (user_id, title) VALUES ($1, $2) RETURNING id`,
    [uid, `AI ${tag}`]);
  await pool.query(
    `INSERT INTO ai_chat_messages
       (chat_id, role, content, tool_trace, model, input_tokens, output_tokens)
     VALUES
       ($1, 'user', $2, NULL, NULL, 5, 0),
       ($1, 'assistant', $3, '{"tools":["overview"]}'::jsonb, 'test-model', 5, 7)`,
    [aiChat.id, `question-${nonce}-${tag}`, `answer-${nonce}-${tag}`]);
  await pool.query(
    `INSERT INTO ai_usage_daily (user_id, day, messages, input_tokens, output_tokens)
     VALUES ($1, CURRENT_DATE, 1, 5, 7)`,
    [uid]);
  return {
    uid, ws, src, msSrc, ymSrc, ch, postId, aiChat: aiChat.id,
    campaign: campaign.id, auditEvent: auditEvent.id,
  };
}

// posts.post_id is a global BIGINT PK (TG message ids in prod) — synthesize unique ones per run.
let nextPostId = Date.now();

const count = async (sql, params) =>
  parseInt((await pool.query(sql, params)).rows[0].count, 10);

test('erasure: deleteUserAccount removes every user-linked row, spares neighbours and shared identity', { skip }, async () => {
  const a = await seedRichUser('era-a');
  const b = await seedRichUser('era-b');

  // B is a member of A's workspace AND parked a channel there (the un-enforced invariant says
  // channels live in their creator's personal workspace — erasure must survive its violation).
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'member')`, [a.ws, b.uid]);
  const srcForeign = await mkSource(`${nonce}-era-foreign`);
  const foreignCh = await mkChannel(b.uid, a.ws, srcForeign, `chan_${nonce}_era_foreign`);
  const parkedPostRef = `${nonce}-era-parked-foreign`;
  // Composite FK (channel_id,workspace_id) used to block the pre-null UPDATE on foreignCh. The
  // contribution belongs to the dying campaign/workspace, so erasure must remove it first.
  await pool.query(
    `INSERT INTO campaign_posts
       (campaign_id, workspace_id, network, channel_id, post_ref, added_by)
     VALUES ($1, $2, 'tg', $3, $4, $5)`,
    [a.campaign, a.ws, foreignCh, parkedPostRef, b.uid]);

  // A SHARED source: B's second channel claims A's source too — it must survive the sweep.
  const sharedCh = await mkChannel(b.uid, b.ws, a.src, `chan_${nonce}_era_shared`);

  // An audit row pointing at A with identifying metadata (the tg.session.connected shape):
  // erasure must keep the row but wipe every direct/correlatable identifier.
  const { rows: [ev] } = await pool.query(
    `INSERT INTO audit_events (uid, action, request_id, ip_hash, metadata)
     VALUES ($1, $2, 'stable-request-id', 'stable-ip-hmac',
             '{"username":"personal_tg_handle"}'::jsonb)
     RETURNING id`,
    [a.uid, `it.${nonce}.era`]);

  assert.strictEqual(await db.deleteUserAccount(a.uid), true, 'reports the deletion');

  // Everything of A is gone — walk every user-linked table.
  for (const [label, sql, params] of [
    ['users', `SELECT count(*) FROM users WHERE id=$1`, [a.uid]],
    ['user_prefs', `SELECT count(*) FROM user_prefs WHERE uid=$1`, [a.uid]],
    ['tg_sessions', `SELECT count(*) FROM tg_sessions WHERE uid=$1`, [a.uid]],
    ['reports', `SELECT count(*) FROM reports WHERE uid=$1`, [a.uid]],
    ['workspaces', `SELECT count(*) FROM workspaces WHERE owner_uid=$1`, [a.uid]],
    ['workspace_members', `SELECT count(*) FROM workspace_members WHERE uid=$1`, [a.uid]],
    ['channels', `SELECT count(*) FROM channels WHERE id=$1`, [a.ch]],
    ['channel_daily', `SELECT count(*) FROM channel_daily WHERE channel_id=$1`, [a.ch]],
    ['posts', `SELECT count(*) FROM posts WHERE channel_id=$1`, [a.ch]],
    ['channel_mention_settings', `SELECT count(*) FROM channel_mention_settings WHERE channel_id=$1`, [a.ch]],
    ['mention_notify_subscriptions', `SELECT count(*) FROM mention_notify_subscriptions WHERE uid=$1`, [a.uid]],
    ['ig_accounts', `SELECT count(*) FROM ig_accounts WHERE channel_id=$1`, [a.ch]],
    ['ig_daily', `SELECT count(*) FROM ig_daily WHERE channel_id=$1`, [a.ch]],
    ['ms_accounts', `SELECT count(*) FROM ms_accounts WHERE channel_id=$1`, [a.ch]],
    ['ms_daily', `SELECT count(*) FROM ms_daily WHERE channel_id=$1`, [a.ch]],
    ['ym_accounts', `SELECT count(*) FROM ym_accounts WHERE channel_id=$1`, [a.ch]],
    ['ym_daily', `SELECT count(*) FROM ym_daily WHERE channel_id=$1`, [a.ch]],
    ['raw_snapshots', `SELECT count(*) FROM raw_snapshots WHERE channel_id=$1`, [a.ch]],
    ['channel_snapshots', `SELECT count(*) FROM channel_snapshots WHERE channel_id=$1`, [a.ch]],
    ['api_keys', `SELECT count(*) FROM api_keys WHERE channel_id=$1`, [a.ch]],
    ['chart_annotations', `SELECT count(*) FROM chart_annotations WHERE channel_id=$1`, [a.ch]],
    ['ms_orders', `SELECT count(*) FROM ms_orders WHERE channel_id=$1`, [a.ch]],
    ['ms_returns', `SELECT count(*) FROM ms_returns WHERE channel_id=$1`, [a.ch]],
    ['campaigns', `SELECT count(*) FROM campaigns WHERE id=$1`, [a.campaign]],
    ['campaign_posts', `SELECT count(*) FROM campaign_posts WHERE campaign_id=$1`, [a.campaign]],
    ['ai_chats', `SELECT count(*) FROM ai_chats WHERE user_id=$1`, [a.uid]],
    ['ai_chat_messages', `SELECT count(*) FROM ai_chat_messages WHERE chat_id=$1`, [a.aiChat]],
    ['ai_usage_daily', `SELECT count(*) FROM ai_usage_daily WHERE user_id=$1`, [a.uid]],
  ]) {
    assert.strictEqual(await count(sql, params), 0, `${label}: erased`);
  }

  // B is untouched, including the channel that lived in A's (now deleted) workspace.
  assert.strictEqual(await count(`SELECT count(*) FROM users WHERE id=$1`, [b.uid]), 1, 'neighbour user survives');
  assert.strictEqual(await count(`SELECT count(*) FROM channels WHERE id=$1`, [b.ch]), 1, 'neighbour channel survives');
  const { rows: [fc] } = await pool.query(`SELECT workspace_id, owner_uid FROM channels WHERE id=$1`, [foreignCh]);
  assert.ok(fc, 'foreign channel in the dying workspace survives');
  assert.strictEqual(fc.workspace_id, null, 'foreign channel falls back to the legacy NULL-workspace path');
  assert.strictEqual(fc.owner_uid, b.uid, 'foreign channel keeps its owner');
  assert.strictEqual(await count(`SELECT count(*) FROM campaign_posts WHERE post_ref=$1`, [parkedPostRef]), 0,
    'dying-workspace campaign membership no longer blocks the foreign channel pre-null');

  // Source claimed by a SURVIVOR = shared identity → survives. Source referenced by NOBODY
  // after the cascade (srcForeign belongs to the surviving foreign channel; B's own src too) —
  // but a truly orphaned one must be swept: give A a second, sole-claim source via seedRichUser?
  // a.src is shared (sharedCh claims it) → survives; srcForeign/b.src still referenced → survive.
  assert.strictEqual(await count(`SELECT count(*) FROM external_sources WHERE id=$1`, [a.src]), 1,
    'source still claimed by a survivor is shared identity and survives');
  assert.strictEqual(await count(`SELECT count(*) FROM channels WHERE id=$1`, [sharedCh]), 1,
    'survivor channel on the shared source is intact');
  assert.strictEqual(await count(`SELECT count(*) FROM external_sources WHERE id=$1`, [b.msSrc]), 1,
    'live neighbour MoySklad canonical source survives the global orphan sweep');
  assert.strictEqual(await count(`SELECT count(*) FROM external_sources WHERE id=$1`, [b.ymSrc]), 1,
    'live neighbour Metrika canonical source survives the global orphan sweep');
  assert.strictEqual(await count(`SELECT count(*) FROM external_sources WHERE id=$1`, [a.msSrc]), 0,
    'erased user orphaned MoySklad canonical source is swept');
  assert.strictEqual(await count(`SELECT count(*) FROM external_sources WHERE id=$1`, [a.ymSrc]), 0,
    'erased user orphaned Metrika canonical source is swept');

  // Audit row survives, but no stable pseudonymous join key remains.
  const { rows: [after] } = await pool.query(
    `SELECT uid, metadata, request_id, ip_hash FROM audit_events WHERE id=$1`, [ev.id]);
  assert.ok(after, 'audit row survives erasure');
  assert.strictEqual(after.uid, null, 'audit row is anonymized (SET NULL)');
  assert.deepStrictEqual(after.metadata, {}, 'identifying metadata is wiped');
  assert.strictEqual(after.request_id, null, 'request correlation id is wiped');
  assert.strictEqual(after.ip_hash, null, 'stable IP HMAC is wiped');
});

test('erasure: a source claimed ONLY by the erased user (private channel) is swept away', { skip }, async () => {
  const a = await seedRichUser('orph-a');
  assert.strictEqual(await db.deleteUserAccount(a.uid), true);
  assert.strictEqual(await count(`SELECT count(*) FROM external_sources WHERE id=$1`, [a.src]), 0,
    'orphaned source (its username/title can identify a private channel owner) is erased');
  assert.strictEqual(await count(`SELECT count(*) FROM external_sources WHERE id IN ($1,$2)`, [a.msSrc, a.ymSrc]), 0,
    'orphaned integration identities are erased too');
});

test('export: streamUserExport carries the archive but never credentials or foreign channels', { skip }, async () => {
  const a = await seedRichUser('exp-a');
  const b = await seedRichUser('exp-b');
  // A is a member of B's workspace — B's channel must NOT appear in A's export.
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'member')`, [b.ws, a.uid]);

  await pool.query(`UPDATE users SET avatar_url='data:image/png;base64,AVATAR' WHERE id=$1`, [a.uid]);

  const { outcome, ready, res, json: data } = await runExport(a.uid);
  assert.strictEqual(outcome, 'ok', 'stream completed');
  assert.strictEqual(ready, true, 'onReady fired before the first byte');
  assert.strictEqual(res.headers['Cache-Control'], undefined, 'headers are the route’s job (onReady), not the service');
  assert.ok(data, 'export exists');
  assert.strictEqual(data.account.id, a.uid);
  assert.strictEqual(data.account.avatar_url, 'data:image/png;base64,AVATAR', 'avatar (personal photo) exported');
  assert.strictEqual(data.channels.length, 1, 'only owned channels are exported');
  assert.strictEqual(data.channels[0].id, a.ch);
  assert.strictEqual(data.channels[0].workspace_id, a.ws, 'channel workspace identity included');
  assert.strictEqual(data.channels[0].status, 'active', 'channel lifecycle status included');
  assert.strictEqual(data.channels[0].archive.daily.length, 1, 'daily archive included');
  assert.strictEqual(data.channels[0].archive.posts.length, 1, 'posts archive included');
  assert.strictEqual(data.channels[0].archive.ms_daily.length, 1, 'MoySklad daily archive included');
  assert.strictEqual(data.channels[0].archive.ms_daily[0].revenue_kopecks, '12500');
  assert.strictEqual(data.channels[0].archive.ms_orders.length, 1, 'MoySklad orders archive included');
  assert.strictEqual(data.channels[0].archive.ms_returns.length, 1, 'MoySklad returns archive included');
  assert.strictEqual(data.channels[0].archive.ms_returns[0].agent_name, 'Personal customer');
  assert.strictEqual(data.channels[0].archive.ym_daily.length, 1, 'Yandex Metrika history included');
  assert.strictEqual(data.channels[0].archive.ym_daily[0].visits, '100');
  assert.strictEqual(data.channels[0].archive.raw_snapshots.length, 1, 'raw provider archive included');
  assert.strictEqual(data.channels[0].archive.raw_snapshots[0].payload.owner_marker, `raw-${nonce}-exp-a`);
  assert.deepStrictEqual(data.channels[0].snapshot.data, {
    subscribers: 42,
    owner_marker: `snapshot-${nonce}-exp-a`,
  }, 'current snapshot included without channel_photo');
  assert.strictEqual(data.channels[0].moysklad.ms_account_id, `${nonce}-exp-a-ms`,
    'MoySklad non-secret account identity included');
  assert.strictEqual(data.channels[0].moysklad.org_name, 'MS exp-a');
  assert.deepStrictEqual(
    data.channels[0].api_keys.map((k) => ({ prefix: k.key_prefix, label: k.label })),
    [{ prefix: 'pa_exp-a', label: 'Collector exp-a' }],
    'API key metadata included without key_hash',
  );
  assert.strictEqual(data.channels[0].yandex_metrika.counter_id, `${nonce}-exp-a-counter`,
    'Yandex Metrika non-secret identity included');
  assert.deepStrictEqual(data.channels[0].mention_settings.include_terms, ['brand'], 'mention rules included');
  assert.strictEqual(data.channels[0].mention_settings.match_mode, 'word');
  assert.deepStrictEqual(data.mention_notify_subscriptions.map((s) => s.channel_id), [a.ch],
    'personal mention subscription included at the top level');
  assert.ok(data.channels[0].instagram, 'ig profile included');
  assert.strictEqual(data.channels[0].instagram.daily.length, 1, 'ig daily included');
  assert.ok(data.telegram_session, 'tg connection presence included');
  assert.strictEqual(data.telegram_session.connection_state, 'degraded', 'TG health state included');
  assert.strictEqual(data.telegram_session.last_error_code, 'upstream', 'allow-listed TG health code included');
  assert.deepStrictEqual(data.prefs, { h: 1 }, 'prefs included');
  assert.deepStrictEqual(data.workspaces.map((w) => ({ id: w.id, kind: w.kind })),
    [{ id: a.ws, kind: 'personal' }], 'only owned workspace rows, with kind');
  assert.ok(data.workspaces.every((w) => !('members' in w)), 'foreign workspace roster is not exported');
  assert.deepStrictEqual(
    data.workspace_memberships.map((m) => ({ id: m.workspace_id, kind: m.workspace_kind })),
    [
      { id: a.ws, kind: 'personal' },
      { id: b.ws, kind: 'personal' },
    ].sort((x, y) => x.id - y.id),
    'only the user’s own membership rows include owned + shared workspaces',
  );
  assert.deepStrictEqual(data.campaigns.map((c) => c.id), [a.campaign], 'only campaigns created by the user');
  assert.deepStrictEqual(data.campaign_posts.map((p) => p.campaign_id), [a.campaign],
    'only campaign-post operations added by the user');
  assert.deepStrictEqual(Object.keys(data.campaign_posts[0]).sort(),
    ['added_at', 'campaign_id', 'channel_id', 'network', 'post_ref'].sort(),
    'campaign post safe projection excludes content and other actors');
  assert.deepStrictEqual(data.audit_events.map((e) => e.id), [a.auditEvent], 'own audit trail included');
  assert.deepStrictEqual(Object.keys(data.audit_events[0]).sort(),
    ['action', 'channel_id', 'created_at', 'id'].sort(), 'audit safe projection only');
  assert.deepStrictEqual(data.ai_chats.map((c) => c.id), [a.aiChat], 'personal AI chats included');
  assert.deepStrictEqual(data.ai_chat_messages.map((m) => m.chat_id), [a.aiChat, a.aiChat],
    'messages are exported only through the user-owned chat');
  assert.deepStrictEqual(data.ai_usage_daily.map((d) => d.messages), [1], 'personal AI usage included');

  // The credential blacklist: nothing that smells like a secret may appear ANYWHERE in the JSON.
  const flat = res.body();
  for (const secret of [
    'SECRET_TG_SESSION', 'SECRET_IG_TOKEN', 'SECRET_MS_TOKEN', 'SECRET_YM_TOKEN',
    `SECRET_API_KEY_HASH_${nonce}_exp-a`, 'SECRET_CHANNEL_PHOTO_exp-a',
    'SECRET_REQUEST_exp-a', 'SECRET_IP_HASH_exp-a', 'SECRET_AUDIT_METADATA_exp-a',
    `caption-${nonce}-exp-a`,
    'pass_hash', 'session_enc', 'access_token_enc', 'token_version', 'key_hash',
    'request_id', 'ip_hash',
  ]) {
    assert.ok(!flat.includes(secret), `export must not contain ${secret}`);
  }

  const exportedIds = data.channels.map((c) => c.id);
  assert.ok(!exportedIds.includes(b.ch), 'membership channel (foreign data) excluded');
  assert.ok(!flat.includes(`raw-${nonce}-exp-b`), 'foreign raw snapshot payload excluded');
  assert.ok(!flat.includes(`question-${nonce}-exp-b`), 'foreign AI conversation excluded');
  assert.ok(!flat.includes(`Campaign ${nonce} exp-b`), 'foreign campaign excluded');
  assert.ok(!flat.includes('pa_exp-b'), 'foreign API key metadata excluded');
});

test('export: disconnected Instagram keeps owned history and never leaks a foreign channel', { skip }, async () => {
  const a = await seedRichUser('ig-off-a');
  const b = await seedRichUser('ig-off-b');
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'member')`,
    [b.ws, a.uid]);
  await pool.query(`DELETE FROM ig_accounts WHERE channel_id=$1`, [a.ch]);
  await pool.query(
    `INSERT INTO ig_media_daily (channel_id, media_id, day, reach)
     VALUES ($1, $2, CURRENT_DATE, 71)`,
    [a.ch, `${nonce}-owned-media`]);
  await pool.query(
    `INSERT INTO ig_media_daily (channel_id, media_id, day, reach)
     VALUES ($1, $2, CURRENT_DATE, 999)`,
    [b.ch, `${nonce}-foreign-media`]);

  const { outcome, res, json: data } = await runExport(a.uid, { pageSize: 1 });
  assert.strictEqual(outcome, 'ok');
  assert.deepStrictEqual(data.channels.map((c) => c.id), [a.ch], 'only the owned channel is present');
  const instagram = data.channels[0].instagram;
  assert.ok(instagram, 'historical section survives removal of ig_accounts');
  assert.strictEqual(instagram.ig_user_id, null);
  assert.strictEqual(instagram.username, null);
  assert.strictEqual(instagram.daily.length, 1, 'owned daily history remains portable');
  assert.deepStrictEqual(instagram.media_daily.map((m) => m.media_id), [`${nonce}-owned-media`]);
  assert.ok(!res.body().includes(`${nonce}-foreign-media`), 'foreign Instagram history is absent');
});

test('export: campaigns/posts require own authorship plus current workspace access', { skip }, async () => {
  const a = await seedRichUser('camp-a');
  const b = await seedRichUser('camp-b');
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'member')`,
    [b.ws, a.uid]);

  // A creates a campaign in B's workspace while A is a member.
  const { rows: [cross] } = await pool.query(
    `INSERT INTO campaigns (workspace_id, name, description, created_by)
     VALUES ($1, $2, 'cross workspace', $3) RETURNING id`,
    [b.ws, `Cross ${nonce}`, a.uid]);
  await pool.query(
    `INSERT INTO campaign_posts
       (campaign_id, workspace_id, network, channel_id, post_ref, caption, added_by)
     VALUES
       ($1, $2, 'tg', $3, $4, 'A private caption', $5),
       ($1, $2, 'tg', $3, $6, 'B colleague caption', $7)`,
    [cross.id, b.ws, b.ch, `${nonce}-cross-by-a`, a.uid, `${nonce}-cross-by-b`, b.uid]);
  // A also adds one membership operation to B's campaign. The campaign metadata is not A's, but
  // A's own operation is portable while current workspace access exists.
  await pool.query(
    `INSERT INTO campaign_posts
       (campaign_id, workspace_id, network, channel_id, post_ref, caption, added_by)
     VALUES ($1, $2, 'ig', $3, $4, 'foreign campaign caption', $5)`,
    [b.campaign, b.ws, b.ch, `${nonce}-b-campaign-by-a`, a.uid]);

  const withAccess = (await runExport(a.uid, { pageSize: 1 })).json;
  assert.deepStrictEqual(
    withAccess.campaigns.map((c) => c.id),
    [a.campaign, cross.id].sort((x, y) => x - y),
    'A-created campaigns are exported in every currently accessible workspace',
  );
  assert.ok(!withAccess.campaigns.some((c) => c.id === b.campaign), 'B-created campaign metadata excluded');
  assert.deepStrictEqual(
    withAccess.campaign_posts.map((p) => p.post_ref).sort(),
    [String(a.postId), `${nonce}-cross-by-a`, `${nonce}-b-campaign-by-a`].sort(),
    'only A-added campaign membership operations are exported',
  );
  assert.ok(!withAccess.campaign_posts.some((p) => p.post_ref === `${nonce}-cross-by-b`),
    'colleague-added post excluded');
  assert.ok(!JSON.stringify(withAccess.campaign_posts).includes('caption'),
    'campaign post content is outside safe projection');

  // created_by/added_by are historical pointers, not an access bypass: after membership removal,
  // every row in B's workspace disappears from A's export.
  await pool.query(`DELETE FROM workspace_members WHERE workspace_id=$1 AND uid=$2`, [b.ws, a.uid]);
  const afterRemoval = (await runExport(a.uid, { pageSize: 1 })).json;
  assert.deepStrictEqual(afterRemoval.campaigns.map((c) => c.id), [a.campaign]);
  assert.deepStrictEqual(afterRemoval.campaign_posts.map((p) => p.post_ref), [String(a.postId)]);
  assert.deepStrictEqual(afterRemoval.workspace_memberships.map((m) => m.workspace_id), [a.ws]);
});

test('export: a subscriber gets their shared-channel subscription without foreign channel data', { skip }, async () => {
  const owner = await seedRichUser('sub-owner');
  const member = await seedRichUser('sub-member');
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'member')`,
    [owner.ws, member.uid]);
  await pool.query(
    `INSERT INTO mention_notify_subscriptions
       (channel_id, uid, enabled, send_days, send_hour, last_error)
     VALUES ($1, $2, true, ARRAY[2, 4], 17, 'search_failed')`,
    [owner.ch, member.uid]);

  const { outcome, res, json: data } = await runExport(member.uid, { pageSize: 1 });
  assert.strictEqual(outcome, 'ok');
  assert.deepStrictEqual(data.channels.map((c) => c.id), [member.ch],
    'owner-only channel export does not pull in the shared channel');
  assert.deepStrictEqual(
    data.mention_notify_subscriptions.map((s) => s.channel_id),
    [member.ch, owner.ch].sort((a, b) => a - b),
    'own + shared subscriptions cross pageSize=1 without omission or duplication',
  );

  const sharedSubscription = data.mention_notify_subscriptions.find((s) => s.channel_id === owner.ch);
  assert.ok(sharedSubscription, 'the member’s personal subscription to the shared channel is exported');
  assert.deepStrictEqual(sharedSubscription.send_days, [2, 4]);
  assert.strictEqual(sharedSubscription.send_hour, 17);
  assert.strictEqual(sharedSubscription.last_error, 'search_failed');

  const flat = res.body();
  assert.ok(!flat.includes(`chan_${nonce}_sub-owner`), 'shared channel username/title is not exported');
  assert.ok(!flat.includes(`${nonce}-sub-owner-counter`), 'shared channel integration identity is not exported');
  assert.ok(!flat.includes('Counter sub-owner'), 'shared channel Metrika metadata is not exported');
  assert.ok(!flat.includes('SECRET_YM_TOKEN'), 'shared channel credential is never exported');
});

test('export: keyset pages tile the archive with no duplication/omission, incl. equal timestamps', { skip }, async () => {
  const a = await seedRichUser('page-a');
  // seedRichUser already added day0 daily + 1 post + 1 ig_daily + 1 annotation. Pile on more so the
  // archive spans several pages at pageSize=2, and force a DUPLICATE date_published so the post
  // keyset must lean on its (date_published, post_id) tie-breaker to avoid dupes/holes on a boundary.
  const day = (n) => `(CURRENT_DATE - ${n})`;
  for (let n = 1; n <= 4; n++) {
    await pool.query(`INSERT INTO channel_daily (channel_id, day, views) VALUES ($1, ${day(n)}, $2)`, [a.ch, n]);
    await pool.query(`INSERT INTO ig_daily (channel_id, day, reach) VALUES ($1, ${day(n)}, $2)`, [a.ch, n]);
    await pool.query(
      `INSERT INTO ym_daily (channel_id, day, visits, users, pageviews)
       VALUES ($1, ${day(n)}, $2, $2, $2)`,
      [a.ch, n]);
    await pool.query(
      `INSERT INTO ms_daily (channel_id, day, revenue_kopecks, orders_count, orders_sum_kopecks)
       VALUES ($1, ${day(n)}, $2, $2, $2)`,
      [a.ch, n]);
    await pool.query(
      `INSERT INTO raw_snapshots (channel_id, source, kind, day, payload)
       VALUES ($1, 'tg', 'graphs', ${day(n)}, jsonb_build_object('n', $2::int))`,
      [a.ch, n]);
    await pool.query(
      `INSERT INTO ig_media_daily (channel_id, media_id, day, reach) VALUES ($1, $2, ${day(n)}, $3)`,
      [a.ch, `media-${n}`, n]);
    await pool.query(`INSERT INTO chart_annotations (channel_id, day, label, created_by) VALUES ($1, ${day(n)}, $2, $3)`,
      [a.ch, `ann-${n}`, a.uid]);
  }
  // Eight posts: two share the SAME date_published, and three have NULL date_published. The NULL
  // tail forces real PostgreSQL through the dense-placeholder branch on a page boundary.
  const sameTs = '2024-03-03T10:00:00.000Z';
  const tsList = [
    sameTs, sameTs, '2024-03-01T00:00:00Z', '2024-03-02T00:00:00Z',
    '2024-03-04T00:00:00Z', null, null, null,
  ];
  for (const ts of tsList) {
    const pid = nextPostId++;
    await pool.query(`INSERT INTO posts (post_id, channel_id, date_published, views) VALUES ($1, $2, $3, 1)`,
      [pid, a.ch, ts]);
  }

  // Whole archive fetched in one shot (large page) is the reference; small pages must match it exactly.
  const big = (await runExport(a.uid, { pageSize: 1000 })).json.channels[0].archive;
  const small = (await runExport(a.uid, { pageSize: 2 })).json.channels[0].archive;

  for (const arr of [
    'daily', 'posts', 'mentions', 'velocity', 'annotations', 'ms_daily', 'ms_orders',
    'ms_returns', 'ym_daily', 'raw_snapshots',
  ]) {
    assert.deepStrictEqual(small[arr], big[arr], `${arr}: paged read equals single-shot read`);
  }
  // Every post present exactly once (no dupes, no holes) despite the shared timestamp + page split.
  assert.strictEqual(small.posts.length, 8 + 1, 'all posts incl. seed post, exactly once');
  const gotIds = small.posts.map((p) => String(p.post_id)).sort();
  const wantIds = big.posts.map((p) => String(p.post_id)).sort();
  assert.deepStrictEqual(gotIds, wantIds, 'post_id set identical — no duplication or omission');
  // Deterministic order: date_published asc, post_id asc — the two equal-ts posts sit adjacent, ordered by id.
  const eq = small.posts
    .filter((p) => p.date_published && new Date(p.date_published).toISOString() === sameTs)
    .map((p) => String(p.post_id));
  assert.deepStrictEqual(eq, [...eq].sort((x, y) => Number(x) - Number(y)), 'equal timestamps break ties by ascending post_id');
  assert.strictEqual(small.posts.filter((p) => p.date_published == null).length, 3,
    'NULL timestamp tail crosses pages without omission');

  const igSmall = (await runExport(a.uid, { pageSize: 2 })).json.channels[0].instagram;
  const igBig = (await runExport(a.uid, { pageSize: 1000 })).json.channels[0].instagram;
  assert.deepStrictEqual(igSmall.daily, igBig.daily, 'ig daily: paged equals single-shot');
  assert.deepStrictEqual(igSmall.media_daily, igBig.media_daily, 'ig media: paged equals single-shot');
});

test('export: workspaces, reports and the channel list also tile in keyset pages (bounded head)', { skip }, async () => {
  const a = await seedRichUser('head-a');
  // Team-workspaces не ограничены partial unique для personal, поэтому добавляем два: все три
  // top-level набора должны пересечь pageSize=2 без опоры на продуктовые cap'ы.
  for (const n of [1, 2]) {
    const { rows: [w] } = await pool.query(
      `INSERT INTO workspaces (name, owner_uid, kind) VALUES ($1, $2, 'team') RETURNING id`,
      [`team-${nonce}-${n}`, a.uid]);
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'owner')`,
      [w.id, a.uid]);
  }
  // Two more reports + a second channel make the remaining head sets span pageSize=2 too.
  for (const n of [1, 2]) {
    await pool.query(`INSERT INTO reports (uid, name, config) VALUES ($1, $2, '{"blocks":[]}'::jsonb)`,
      [a.uid, `report2-${nonce}-${n}`]);
  }
  const src2 = await mkSource(`${nonce}-head-2`);
  const ch2 = await mkChannel(a.uid, a.ws, src2, `chan2_${nonce}_head`);
  await pool.query(`INSERT INTO channel_daily (channel_id, day, views) VALUES ($1, CURRENT_DATE, 7)`, [ch2]);

  const big = (await runExport(a.uid, { pageSize: 1000 })).json;
  const small = (await runExport(a.uid, { pageSize: 2 })).json;

  assert.deepStrictEqual(small.workspaces, big.workspaces, 'workspaces: paged read equals single-shot');
  assert.strictEqual(small.workspaces.length, 3, 'personal + two team workspaces, exactly once');
  assert.deepStrictEqual(small.reports, big.reports, 'reports: paged read equals single-shot');
  assert.strictEqual(small.reports.length, 3, 'all three reports, exactly once across page boundaries');
  assert.deepStrictEqual(small.channels, big.channels, 'channel list: paged read equals single-shot');
  assert.strictEqual(small.channels.length, 2, 'both channels present across the paged list');
});

test('export: a missing user streams nothing and reports not_found', { skip }, async () => {
  const { outcome, ready, res } = await runExport(2_000_000_000);
  assert.strictEqual(outcome, 'not_found');
  assert.strictEqual(ready, false, 'onReady not fired — 404 still possible');
  assert.strictEqual(res.chunks.length, 0, 'not a single byte written');
});

test('erasure: deleting one user twice is a clean false, not an error', { skip }, async () => {
  const uid = await mkUser('era-twice');
  assert.strictEqual(await db.deleteUserAccount(uid), true);
  assert.strictEqual(await db.deleteUserAccount(uid), false, 'second delete reports nothing to erase');
});
