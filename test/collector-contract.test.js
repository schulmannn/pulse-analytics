const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ContractError,
  normalizeEnvelope,
  prepareStorage,
} = require('../server/collector/contract');
const { createCollectorHandler } = require('../server/routes/collector');

function validPayload() {
  return {
    schema_version: 1,
    ingest_id: '550e8400-e29b-41d4-a716-446655440000',
    collector_version: '1.0.0',
    collected_at: '2026-06-25T12:00:00Z',
    channel: { id: '12345', title: 'Channel', username: 'channel', members: '100' },
    stats: { followers: { current: '100', previous: '90' } },
    graphs: {
      available: true,
      growth: { x: [Date.UTC(2026, 5, 25)], series: [{ name: 'Total', values: ['100'] }] },
    },
    views_summary: { total_views: '500', posts_analyzed: '1' },
    posts: [{
      id: '9', date: '2026-06-25T10:00:00Z', text: 'hello',
      views: '500', reactions: '5', forwards: '2', replies: '1',
      media_type: 'text', hashtags: ['#test'],
    }],
    velocity: { available: true, posts_used: 1 },
    mentions: [],
  };
}

test('collector contract coerces metrics and prepares normalized storage rows', () => {
  const normalized = normalizeEnvelope(validPayload());
  assert.strictEqual(normalized.channel.members, 100);
  assert.strictEqual(normalized.posts[0].views, 500);
  assert.strictEqual(normalized.graphs.growth.series[0].values[0], 100);
  const storage = prepareStorage(normalized, () => [{ day: '2026-06-25', subscribers: 100 }]);
  assert.strictEqual(storage.postRows[0].post_id, 9);
  assert.strictEqual(storage.postRows[0].erv, 1.6);
  assert.strictEqual(storage.dailyRows.length, 1);
});

test('unsupported collector schema is rejected with a contract error', () => {
  const payload = validPayload();
  payload.schema_version = 99;
  assert.throws(() => normalizeEnvelope(payload), ContractError);
});

test('legacy payload receives deterministic ingest id and warning marker', () => {
  const payload = validPayload();
  delete payload.ingest_id;
  delete payload.schema_version;
  const first = normalizeEnvelope(payload);
  const second = normalizeEnvelope(payload);
  assert.match(first.ingest_id, /^legacy-/);
  assert.strictEqual(first.ingest_id, second.ingest_id);
  assert.strictEqual(first.legacy, true);
});

test('collector handler returns stored duplicate result without applying data itself', async () => {
  let calls = 0;
  const db = {
    graphsToDailyRows: () => [],
    ingestCollectorPayload: async (_channelId, meta) => {
      calls += 1;
      return { ok: true, ingest_id: meta.ingest_id, duplicate: calls > 1 };
    },
  };
  const handler = createCollectorHandler({ db });
  const request = { body: validPayload(), channel: { id: 7 }, requestId: 'request-1' };
  const responses = [];
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { responses.push({ status: this.statusCode, body }); return this; },
  };
  await handler(request, response);
  await handler(request, response);
  assert.strictEqual(responses[0].status, 202);
  assert.strictEqual(responses[1].status, 200);
  assert.strictEqual(responses[1].body.duplicate, true);
});
