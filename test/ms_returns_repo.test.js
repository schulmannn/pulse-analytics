'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollectorRepo } = require('../server/repos/collectorRepo');

function repoWithQueries() {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  return {
    queries,
    repo: createCollectorRepo({
      pool,
      enabled: true,
      transaction: async (fn) => fn(pool),
      setChannelTgId: async () => {},
    }),
  };
}

test('upsertMsReturns replaces a corrected row without COALESCE semantics', async () => {
  const { repo, queries } = repoWithQueries();
  const n = await repo.upsertMsReturns(7, [{
    return_id: 'r-1', moment: '2026-07-18 10:00:00.000', sum_kopecks: 0,
    agent_id: null, agent_name: null,
  }]);
  assert.equal(n, 1);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /sum_kopecks=EXCLUDED\.sum_kopecks/);
  assert.doesNotMatch(queries[0].sql, /COALESCE\(x\.sum_kopecks/);
});

test('upsertMsReturns fails before SQL for missing, negative or unsafe money', async () => {
  for (const value of [null, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const { repo, queries } = repoWithQueries();
    await assert.rejects(
      repo.upsertMsReturns(7, [{
        return_id: 'r-1', moment: '2026-07-18 10:00:00.000', sum_kopecks: value,
      }]),
      { code: 'ms_return_metric_out_of_range' },
    );
    assert.equal(queries.length, 0);
  }
});
