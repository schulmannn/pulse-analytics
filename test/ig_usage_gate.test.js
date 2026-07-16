'use strict';

// Unit-тесты createIgUsageGate — общего app-level numeric-only тормоза IG Graph. Инъектируем часы
// → детерминизм. Проверяем: наблюдение app-usage максимума, fail-open на битых заголовках, жёсткую
// остановку при usage>=100 + истечение через probeIntervalMs (bounded probe), паузу по Graph коду 4
// с Retry-After, что user/page код 17/32 глобальный gate НЕ открывает, и что снимок строго числовой.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIgUsageGate } = require('../server/infrastructure/igUsageGate');

// Управляемые часы: t мутируется тестом, gate читает clock() на каждом обращении.
function fixedClock(start = 1_000_000) {
  const box = { t: start };
  return { now: () => box.t, box };
}

test('observe: app-usage максимум удержан, gate закрыт при usage<100', () => {
  const { now } = fixedClock();
  const gate = createIgUsageGate({ now, probeIntervalMs: 60_000 });
  gate.observe({ appUsage: { call_count: 40, total_cputime: 80, total_time: 55 }, status: 200 });
  assert.equal(gate.shouldStopPass(), false);
  const snap = gate._snapshot();
  assert.equal(snap.lastAppUsagePct, 80);   // максимум процент-полей
  assert.equal(snap.stoppedUntilMs, 0);
});

test('observe: битые/непонятные заголовки fail-open и не бросают', () => {
  const { now } = fixedClock();
  const gate = createIgUsageGate({ now, probeIntervalMs: 60_000 });
  assert.doesNotThrow(() => gate.observe({ appUsage: 'not-an-object', businessUseCaseUsage: [1, 2], status: 200 }));
  assert.doesNotThrow(() => gate.observe(null));
  assert.doesNotThrow(() => gate.observe({ appUsage: { call_count: 'NaN' }, graphCode: 'x' }));
  assert.equal(gate.shouldStopPass(), false);
  assert.equal(gate._snapshot().lastAppUsagePct, 0);
});

test('жёсткая остановка при app usage>=100 и истечение через probeIntervalMs (bounded probe)', () => {
  const { now, box } = fixedClock();
  const gate = createIgUsageGate({ now, probeIntervalMs: 60_000 });
  gate.observe({ appUsage: { call_count: 100 }, status: 200 });
  assert.equal(gate.shouldStopPass(), true);
  assert.equal(gate.remainingSeconds(), 60);
  box.t += 59_999;
  assert.equal(gate.shouldStopPass(), true, 'всё ещё в паузе за 1мс до истечения');
  box.t += 2;   // перешли границу probeIntervalMs
  assert.equal(gate.shouldStopPass(), false, 'состояние истекло → следующий проход может пробовать');
  assert.equal(gate.remainingSeconds(), 0);
});

test('Graph app-rate код 4 с Retry-After открывает gate и уважает более длинный Retry-After', () => {
  const { now, box } = fixedClock();
  const gate = createIgUsageGate({ now, probeIntervalMs: 60_000 });
  // 429 + код 4 + Retry-After 120с > probe(60с) → пауза = 120с.
  gate.observe({ appUsage: { call_count: 10 }, graphCode: 4, retryAfterSeconds: 120, status: 429 });
  assert.equal(gate.shouldStopPass(), true);
  assert.equal(gate.remainingSeconds(), 120);
  box.t += 119_000;
  assert.equal(gate.shouldStopPass(), true);
  box.t += 2_000;
  assert.equal(gate.shouldStopPass(), false);
});

test('код 4 без Retry-After всё равно тормозит на probeIntervalMs', () => {
  const { now } = fixedClock();
  const gate = createIgUsageGate({ now, probeIntervalMs: 90_000 });
  gate.observe({ appUsage: { call_count: 12 }, graphCode: 4, status: 400 });
  assert.equal(gate.shouldStopPass(), true);
  assert.equal(gate.remainingSeconds(), 90);
});

test('user/page код 17/32 без app-usage=100 глобальный app-gate НЕ открывает', () => {
  const { now } = fixedClock();
  for (const code of [17, 32]) {
    const gate = createIgUsageGate({ now, probeIntervalMs: 60_000 });
    gate.observe({ appUsage: { call_count: 50 }, graphCode: code, retryAfterSeconds: 30, status: 429 });
    assert.equal(gate.shouldStopPass(), false, `код ${code} не открывает глобальный gate`);
    assert.equal(gate._snapshot().stoppedUntilMs, 0);
  }
});

test('BUC максимум наблюдается численно, но user/page BUC сам по себе gate не открывает', () => {
  const { now } = fixedClock();
  const gate = createIgUsageGate({ now, probeIntervalMs: 60_000 });
  // BUC keyed by business id — id НЕ удерживается, читаем только числовые проценты вложенных записей.
  gate.observe({
    businessUseCaseUsage: { '1789': [{ type: 'instagram', call_count: 95, total_cputime: 12, estimated_time_to_regain_access: 5 }] },
    graphCode: 17, status: 429, retryAfterSeconds: 300,
  });
  assert.equal(gate.shouldStopPass(), false, 'BUC/user лимит не открывает app-gate');
  assert.equal(gate._snapshot().lastBucUsagePct, 95);   // estimated_time_to_regain_access не спутан с %
});

test('снимок строго числовой — ни токенов, ни identity, ни сырых заголовков', () => {
  const { now } = fixedClock(2_000_000);
  const gate = createIgUsageGate({ now, probeIntervalMs: 60_000 });
  gate.observe({
    appUsage: { call_count: 100 }, businessUseCaseUsage: { biz: [{ call_count: 30 }] },
    graphCode: 4, retryAfterSeconds: 10, status: 429,
  });
  const snap = gate._snapshot();
  for (const [k, v] of Object.entries(snap)) {
    assert.equal(typeof v, 'number', `snapshot.${k} обязан быть числом, а не ${typeof v}`);
  }
  // Никаких полей идентичности/сырья.
  assert.deepEqual(
    Object.keys(snap).sort(),
    ['lastAppUsagePct', 'lastBucUsagePct', 'lastObservedMs', 'probeIntervalMs', 'remainingMs', 'stoppedUntilMs'],
  );
});

test('самое позднее восстановление выигрывает: последующее короткое наблюдение не сокращает паузу', () => {
  const { now } = fixedClock();
  const gate = createIgUsageGate({ now, probeIntervalMs: 60_000 });
  gate.observe({ graphCode: 4, retryAfterSeconds: 200, status: 429 });   // пауза 200с
  assert.equal(gate.remainingSeconds(), 200);
  gate.observe({ appUsage: { call_count: 100 }, status: 200 });          // probe 60с < остатка
  assert.equal(gate.remainingSeconds(), 200, 'короткая пауза не укорачивает уже установленную длинную');
});
