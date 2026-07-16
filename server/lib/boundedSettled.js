// ═══════════════════════════════════════════════════════════════
//  Atlavue — bounded-concurrency Promise.allSettled (lib, zero deps)
// ═══════════════════════════════════════════════════════════════
// Прогоняет worker(item, index) по items с не более чем `concurrency` вызовами в полёте,
// СОХРАНЯЯ порядок входа в массиве результатов, и НИКОГДА не реджектит: каждый слот резолвится
// в { status:'fulfilled', value } или { status:'rejected', reason } — ровно как Promise.allSettled.
// Нужен, чтобы ограничить дневной IG-фан-аут (метрики/демография/сторис) без потери per-item
// изоляции: один reject не топит батч. Без зависимостей.

'use strict';

async function boundedAllSettled(items, worker, concurrency = 2) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const limit = Math.max(1, Math.floor(Number(concurrency)) || 1);
  let next = 0;

  async function runOne() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await worker(list[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const runners = [];
  for (let k = 0; k < Math.min(limit, list.length); k++) runners.push(runOne());
  await Promise.all(runners);
  return results;
}

module.exports = { boundedAllSettled };
